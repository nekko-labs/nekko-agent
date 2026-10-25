import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import NekkoProtocol
import Observation

/// Nekko Cloud on the iPhone: sign in (Supabase Auth proves who you are, the
/// device token comes from Nekko Cloud), join the account's end-to-end
/// encrypted sync with the recovery key or by being approved on a computer,
/// approve a new computer from here (with the join code it shows), and read
/// the synced chats without the computer online. The phone reads sync; it
/// doesn't write chats (they live on the computer that runs them) and never
/// starts a key epoch. It takes a new epoch only from a device its current
/// account record trusts, and only records under the epoch it holds.
///
/// The crypto is `SyncCrypto` (held to `crates/nekko-sync`'s vectors); the
/// flows match `crates/nekko-cloud`. Secrets go in the `SecureStore` (the
/// Keychain); the decrypted chats in `OfflineFiles` (encrypted until first
/// unlock, never backed up).
@MainActor
@Observable
public final class CloudSync {
    public enum Phase: String, Sendable {
        case signedOut = "signed-out"
        case needsPlan = "needs-plan"
        /// Signed in on Pro or Team, but no computer has turned sync on yet.
        case notSetUp = "off"
        case needsJoin = "needs-join"
        case awaitingApproval = "awaiting-approval"
        case syncing
        case idle
        case error
    }

    public struct Account: Equatable, Sendable {
        public var id: String
        public var email: String
        public var plan: String
        public var canSync: Bool
    }

    public struct Device: Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let fingerprint: String
        public let revoked: Bool
        public let trusted: Bool
        public let thisDevice: Bool
        /// It asked to join: approve it with the code its screen shows.
        public let askedToJoin: Bool
    }

    public struct Chat: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        public let updatedAt: Double
        public let messages: [Message]
    }

    public struct Message: Equatable, Sendable {
        public let role: String
        public let text: String
    }

    public private(set) var account: Account?
    public private(set) var devices: [Device] = []
    public private(set) var chats: [Chat] = []
    public private(set) var syncing = false
    public private(set) var error: String?
    public private(set) var lastSyncAt: Date?
    /// The account already syncs (a key epoch exists on the server).
    public var accountSyncs: Bool { remoteKeyId != nil }
    /// The newest key epoch on the server.
    private var remoteKeyId: UInt32?
    /// This iPhone asked to join and is waiting for a computer to approve it.
    public private(set) var waitingForApproval = false
    /// While waiting: the one-time code to type on the computer that approves this iPhone.
    public private(set) var joinCode: String?
    /// The device the current token is bound to, per the server.
    private var boundDevice: String?

    public static let oauthProviders = ["apple", "github", "google"]
    /// Where the browser comes back to (Info.plist `nekko-agent` scheme; allowed in Supabase's redirect list).
    public static let oauthRedirect = "nekko-agent://cloud-callback"

    private let api: URL
    private let http: CloudHTTP
    private let secrets: SecureStore
    private let files: OfflineFiles?
    private let deviceLabel: String
    private let key: () throws -> SyncAgreementKey
    private var state: State
    private var supabase: (url: String, anon: String)?

    /// What survives a relaunch, none of it secret.
    struct State: Codable, Equatable {
        var account: Account?
        /// The account this iPhone's keys and chats belong to; kept across sign-out,
        /// so signing in to another account forgets them.
        var keysAccount: String?
        var deviceId: String?
        var keyId: UInt32?
        var recoveryPublic: String?
        var accountRecord: String?
        var cursor: Int64 = 0
        var revisions: [String: Int64] = [:]
        var waiting = false
    }

    /// - Parameter key: this iPhone's agreement key, made on first use (a Secure Enclave key on a device).
    public init(api: URL, http: CloudHTTP = URLSessionCloudHTTP(), secrets: SecureStore, files: OfflineFiles?,
                deviceLabel: String, key: @escaping () throws -> SyncAgreementKey) {
        self.api = api
        self.http = http
        self.secrets = secrets
        self.files = files
        self.deviceLabel = deviceLabel
        self.key = key
        state = secrets.get("cloud.state").flatMap { try? JSONDecoder().decode(State.self, from: Data($0.utf8)) } ?? State()
        account = state.account
        waitingForApproval = state.waiting
        joinCode = state.waiting ? secrets.get("cloud.joinCode") : nil
        chats = Self.decodeChats(files?.load("cloud", "chats"))
    }

    public var signedIn: Bool { account != nil && secrets.get("cloud.token") != nil }

    public var phase: Phase {
        if !signedIn { return .signedOut }
        if account?.canSync != true { return .needsPlan }
        if syncing { return .syncing }
        if hasKeys { return error == nil ? .idle : .error }
        if waitingForApproval { return .awaitingApproval }
        return accountSyncs ? .needsJoin : .notSetUp
    }

    var hasKeys: Bool { state.keyId.flatMap { keyring($0) } != nil }

    /// A short code for this iPhone's key, to tell devices apart in the list.
    public var fingerprint: String? { (try? key()).map { SyncCrypto.fingerprint(publicKey: $0.publicKeyX963) } }

    // MARK: Sign-in

    public func sendCode(email: String) async throws {
        let s = try await supabaseConfig()
        _ = try await request("POST", URL(string: "\(s.url)/auth/v1/otp")!, json: .object(["email": .string(email), "create_user": .bool(true)]),
                              headers: ["apikey": s.anon, "Authorization": "Bearer \(s.anon)"])
    }

    public func verifyCode(email: String, code: String) async throws {
        let s = try await supabaseConfig()
        let body: JSONValue = .object(["type": .string("email"), "email": .string(email), "token": .string(code)])
        let v: JSONValue
        do {
            v = try await request("POST", URL(string: "\(s.url)/auth/v1/verify")!, json: body, headers: ["apikey": s.anon, "Authorization": "Bearer \(s.anon)"])
        } catch let e as CloudError where e.status == 403 || e.status == 400 {
            throw CloudError(status: e.status, message: "That code didn't work. Check it, or send a new one.")
        }
        try await finishSignIn(accessToken: v.str("access_token") ?? "")
    }

    /// The browser sign-in: open `url` in ASWebAuthenticationSession, then pass the returned `code` with `verifier` to `finishOAuth`.
    public func oauthStart(provider: String) async throws -> (url: URL, verifier: String) {
        guard Self.oauthProviders.contains(provider) else { throw CloudError(message: "That sign-in isn't offered.") }
        let s = try await supabaseConfig()
        let verifier = SyncCrypto.base64url(E2E.randomBytes(32))
        let challenge = SyncCrypto.pkceChallenge(verifier)
        var c = URLComponents(string: "\(s.url)/auth/v1/authorize")!
        c.queryItems = [URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "redirect_to", value: Self.oauthRedirect),
                        URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "s256")]
        return (c.url!, verifier)
    }

    public func finishOAuth(callback: URL, verifier: String) async throws {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let code = items.first(where: { $0.name == "code" })?.value else {
            // Not the callback's own text: only fixed wording is shown.
            throw CloudError(message: "Sign-in didn't finish. Try again.")
        }
        let s = try await supabaseConfig()
        let v = try await request("POST", URL(string: "\(s.url)/auth/v1/token?grant_type=pkce")!,
                                  json: .object(["auth_code": .string(code), "code_verifier": .string(verifier)]),
                                  headers: ["apikey": s.anon, "Authorization": "Bearer \(s.anon)"])
        try await finishSignIn(accessToken: v.str("access_token") ?? "")
    }

    func finishSignIn(accessToken: String) async throws {
        guard !accessToken.isEmpty else { throw CloudError(message: "Supabase didn't return a session.") }
        let v = try await request("POST", path("/v1/auth/session"), json: .object(["accessToken": .string(accessToken), "label": .string(deviceLabel)]))
        guard let token = v.str("token") else { throw CloudError(message: "Nekko Cloud sent no token.") }
        let a = Self.account(v["account"])
        if let old = state.keysAccount ?? state.account?.id, old != a.id {
            // Another account's keys and chats never mix with this one's.
            forgetKeys()
            state = State()
        }
        secrets.set("cloud.token", token)
        state.account = a
        state.keysAccount = a.id
        account = a
        save()
        try? await refresh()
    }

    public func signOut() async {
        if let t = secrets.get("cloud.token") {
            _ = try? await request("DELETE", path("/v1/auth/session"), token: t)
        }
        secrets.set("cloud.token", nil)
        state.keysAccount = state.keysAccount ?? state.account?.id
        state.account = nil
        account = nil
        devices = []
        boundDevice = nil
        save()
    }

    // MARK: State from the server

    public func refresh() async throws {
        let t = try token()
        let me = try await request("GET", path("/v1/auth/me"), token: t)
        let a = Self.account(me["account"])
        state.account = a
        account = a
        let remote = try await request("GET", path("/v1/sync/state"), token: t)
        // A number the server sends that doesn't fit is treated as missing, never trapped on.
        remoteKeyId = remote.long("currentKeyId").flatMap { UInt32(exactly: $0) }.flatMap { $0 >= 1 ? $0 : nil }
        boundDevice = remote.str("device")
        let trusted = Set(Self.accountRecord(state.accountRecord)?.devices.map(\.id) ?? [])
        devices = (remote["devices"]?.array ?? []).compactMap { d in
            guard let id = d.str("id") else { return nil }
            let pk = d.str("publicKey").flatMap { try? SyncCrypto.fromBase64url($0) } ?? Data()
            return Device(id: id, label: d.str("label") ?? "Device", fingerprint: SyncCrypto.fingerprint(publicKey: pk),
                          revoked: !(d["revokedAt"]?.isNull ?? true), trusted: trusted.contains(id), thisDevice: id == state.deviceId,
                          askedToJoin: !(d["joinTag"]?.isNull ?? true))
        }
        save()
    }

    // MARK: Joining

    /// Register this iPhone with a join code and wait for a computer to approve it.
    /// The code (`joinCode`) is typed on that computer.
    public func requestJoin() async throws {
        let t = try token()
        try await refresh()
        guard let accountId = account?.id else { throw CloudError(message: "Sign in first.") }
        let code = secrets.get("cloud.joinCode").flatMap { try? SyncCrypto.JoinCode(text: $0) } ?? {
            let c = SyncCrypto.JoinCode.generate()
            secrets.set("cloud.joinCode", c.text)
            return c
        }()
        joinCode = code.text
        let device = try key()
        _ = try await ensureDevice(token: t, joinTag: code.tag(account: accountId, publicKey: device.publicKeyX963))
        state.waiting = true
        waitingForApproval = true
        save()
        try await refresh()
    }

    /// Join with the recovery key: open the current epoch's recovery wrap, check
    /// that epoch's account record names this recovery key, then add this iPhone.
    public func restore(recoveryKey text: String) async throws {
        let t = try token()
        let rk: SyncCrypto.RecoveryKey
        do { rk = try SyncCrypto.RecoveryKey(text: text) } catch { throw CloudError(message: "That isn't a valid recovery key. Check it for typos.") }
        try await refresh()
        guard let accountId = account?.id else { throw CloudError(message: "Sign in first.") }
        guard let current = remoteKeyId else {
            throw CloudError(message: "This account doesn't sync yet. Turn sync on on your computer first.")
        }
        let (device, deviceId) = try await ensureDevice(token: t, joinTag: nil)
        let ring = try await request("GET", path("/v1/sync/keyrings/\(current)"), token: t)
        let keyring: SyncCrypto.Keyring
        do {
            keyring = try SyncCrypto.openRecovery(rk, account: accountId, keyId: current, blob: ring.str("recoveryWrap") ?? "")
        } catch {
            throw CloudError(message: "That recovery key doesn't belong to this account.")
        }
        state.recoveryPublic = SyncCrypto.base64url(SyncCrypto.recoveryAgreementKey(rk).publicKeyX963)
        // Never invent a record: without the account's own, the other devices would be dropped.
        guard let (record, oid, rev) = try await fetchAccount(token: t, keyring: keyring, accountId: accountId, epoch: current) else {
            throw CloudError(message: "Nekko Cloud didn't send this account's record. Try again in a moment.")
        }
        let wrap = try SyncCrypto.wrapKeyring(keyring, account: accountId, keyId: current, recipientId: deviceId,
                                              recipientPublic: device.publicKeyX963, senderId: deviceId, sender: device)
        do {
            _ = try await request("PUT", path("/v1/sync/keyrings/\(current)/wraps/\(deviceId)"), json: .object(["wrap": .string(wrap)]), token: t)
        } catch let e as CloudError where e.code == "wrap-exists" {}
        holdEpoch(current, keyring, record: record, oid: oid, revision: rev)
        state.waiting = false
        waitingForApproval = false
        save()
        let me = TrustedDevice(id: deviceId, publicKey: SyncCrypto.base64url(device.publicKeyX963), label: deviceLabel)
        try await updateAccount(token: t) { $0.add(me) }
        try await sync()
    }

    /// On this iPhone, approve a computer that asked to join, with the join code its screen shows.
    public func approve(deviceId: String, code text: String) async throws {
        let t = try token()
        let code: SyncCrypto.JoinCode
        do { code = try SyncCrypto.JoinCode(text: text) } catch { throw CloudError(message: "Type the 16-character code the computer shows.") }
        try await sync()
        guard let accountId = account?.id, let current = state.keyId, let kr = keyring(current) else {
            throw CloudError(message: "This iPhone doesn't sync yet.")
        }
        let remote = try await request("GET", path("/v1/sync/state"), token: t)
        guard let d = remote["devices"]?.array?.first(where: { $0.str("id") == deviceId }),
              let pk = d.str("publicKey").flatMap({ try? SyncCrypto.fromBase64url($0) }) else {
            throw CloudError(message: "That device isn't on this account.")
        }
        guard d["revokedAt"]?.isNull ?? true else { throw CloudError(message: "That device was removed.") }
        let label = d.str("label") ?? "the computer"
        // The key Nekko Cloud shows must be the one the code was made for; a swapped key fails here.
        let tag = d.str("joinTag").flatMap { try? SyncCrypto.fromBase64url($0) } ?? Data()
        guard code.verifies(account: accountId, publicKey: pk, tag: tag) else {
            throw CloudError(message: "That code doesn't match \(label). Check the code on that computer and type it again.")
        }
        let joining = TrustedDevice(id: deviceId, publicKey: SyncCrypto.base64url(pk), label: d.str("label") ?? "")
        try await updateAccount(token: t) { $0.add(joining) }
        let wrap = try SyncCrypto.wrapForJoin(kr, account: accountId, keyId: current, recipientId: deviceId, recipientPublic: pk, code: code)
        _ = try await request("PUT", path("/v1/sync/keyrings/\(current)/wraps/\(deviceId)"), json: .object(["wrap": .string(wrap)]), token: t)
        try await refresh()
    }

    // MARK: Sync (read)

    public func sync() async throws {
        let t = try token()
        syncing = true
        defer { syncing = false }
        do {
            try await refresh()
            if state.keyId != nil && remoteKeyId == nil {
                // Everything synced was deleted (on a computer, or by the server).
                forgetKeys()
                resetSync()
                throw CloudError(message: "Everything synced was deleted from Nekko Cloud.")
            }
            if !hasKeys {
                guard try await finishJoin(token: t) else { return } // still waiting to be approved
            } else {
                // Signed in again since this iPhone registered: bind the new token to it.
                _ = try await ensureDevice(token: t, joinTag: nil)
            }
            let remote = remoteKeyId ?? 0
            let mine = state.keyId ?? 0
            if remote < mine { throw CloudError(message: "Nekko Cloud reports an older sync key than this iPhone holds. Nothing was synced.") }
            if remote > mine { guard try await adopt(token: t, target: remote) else { return } }
            for _ in 0..<3 {
                if try await pull(token: t) { break }
                try await refresh()
                guard try await adopt(token: t, target: remoteKeyId ?? 0) else { return }
            }
            error = nil
            lastSyncAt = Date()
        } catch {
            self.error = (error as? CloudError)?.message ?? error.localizedDescription
            throw error
        }
    }

    /// The keyring a computer wrapped to this iPhone with its join code, once approved.
    private func finishJoin(token t: String) async throws -> Bool {
        guard let accountId = account?.id, let deviceId = state.deviceId,
              let code = secrets.get("cloud.joinCode").flatMap({ try? SyncCrypto.JoinCode(text: $0) }),
              let current = remoteKeyId else { return false }
        let device = try key()
        let me = SyncCrypto.base64url(device.publicKeyX963)
        // The approval may predate a rotation: look back a few epochs, then catch up through the chain.
        for k in stride(from: current, through: max(1, current > 4 ? current - 4 : 1), by: -1) {
            let ring = try await request("GET", path("/v1/sync/keyrings/\(k)"), token: t)
            guard let w = ring.str("wrap"),
                  let kr = try? SyncCrypto.unwrapJoin(key: device, account: accountId, keyId: k, deviceId: deviceId, code: code, wrap: w) else { continue }
            guard let (record, oid, rev) = try await fetchAccount(token: t, keyring: kr, accountId: accountId, epoch: k),
                  record.lists(id: deviceId, publicKey: me) else { return false }
            holdEpoch(k, kr, record: record, oid: oid, revision: rev)
            secrets.set("cloud.joinCode", nil)
            joinCode = nil
            state.waiting = false
            waitingForApproval = false
            save()
            if k < current { return try await adopt(token: t, target: current) }
            return true
        }
        return false
    }

    /// Move to a newer key epoch, one at a time: each keyring only from a wrap
    /// made by a device the record of the epoch this iPhone holds trusts, and
    /// only once that epoch's own record lists this iPhone. False while the
    /// new epoch's record isn't written yet.
    private func adopt(token t: String, target: UInt32) async throws -> Bool {
        guard let accountId = account?.id, let deviceId = state.deviceId else { throw CloudError(message: "This iPhone has no sync keys.") }
        let device = try key()
        let me = SyncCrypto.base64url(device.publicKeyX963)
        while let mine = state.keyId, mine < target {
            let next = mine + 1
            guard let trusted = Self.accountRecord(state.accountRecord), trusted.epoch == mine else {
                throw CloudError(message: "This iPhone hasn't read the account record yet.")
            }
            let ring = try await request("GET", path("/v1/sync/keyrings/\(next)"), token: t)
            guard let w = ring.str("wrap") else { throw CloudError(message: Self.removed) }
            let found = trusted.devices.lazy.compactMap { d -> SyncCrypto.Keyring? in
                guard let pk = try? SyncCrypto.fromBase64url(d.publicKey) else { return nil }
                return try? SyncCrypto.unwrapKeyring(key: device, account: accountId, keyId: next, deviceId: deviceId, senderId: d.id,
                                                     senderPublic: pk, wrap: w)
            }.first
            guard let kr = found else { throw CloudError(message: "A new sync key came from a device this iPhone doesn't trust. It was refused.") }
            guard let (record, oid, rev) = try await fetchAccount(token: t, keyring: kr, accountId: accountId, epoch: next) else { return false }
            guard record.lists(id: deviceId, publicKey: me) else { throw CloudError(message: Self.removed) }
            holdEpoch(next, kr, record: record, oid: oid, revision: rev)
        }
        return true
    }

    /// Pull and apply everything new. False when it stopped at a record under a
    /// newer key epoch than this iPhone holds (it stays unread until then).
    private func pull(token t: String) async throws -> Bool {
        guard let accountId = account?.id else { return true }
        var byId = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, $0) })
        defer {
            chats = byId.values.sorted { $0.updatedAt > $1.updatedAt }
            files?.save("cloud", "chats", Self.encodeChats(chats))
            save()
        }
        while true {
            let page = try await request("GET", path("/v1/sync/pull?since=\(state.cursor)&limit=200"), token: t)
            let objects = page["objects"]?.array ?? []
            for o in objects {
                if let kid = o.long("keyId"), kid > Int64(state.keyId ?? 0) { return false }
                try apply(o, accountId: accountId, into: &byId)
                if let seq = o.long("seq") { state.cursor = max(state.cursor, seq) }
            }
            state.cursor = max(state.cursor, page.long("next") ?? state.cursor)
            if page["more"]?.bool != true || objects.isEmpty { return true }
        }
    }

    /// Open one pulled object. Only records under the epoch this iPhone holds
    /// count; anything that doesn't open, or isn't newer than a revision seen
    /// (a rollback), is ignored.
    func apply(_ o: JSONValue, accountId: String, into byId: inout [String: Chat]) throws {
        guard let collection = o.str("collection"), let oid = o.str("objectId"), let rev = o.long("revision"), rev >= 1,
              let kid = o.long("keyId").flatMap({ UInt32(exactly: $0) }), kid == state.keyId, o.str("blob") != nil else { return }
        if let seen = state.revisions[oid], seen >= rev { return }
        guard let kr = keyring(kid) else { return }
        switch collection {
        case "account":
            guard let (record, _, _) = try? openAccount(o, keyring: kr, accountId: accountId, epoch: kid) else { return }
            keepAccount(record, oid: oid, revision: rev)
            if let me = state.deviceId, !record.trusts(me) { throw CloudError(message: Self.removed) }
            return
        case "chat":
            guard let plain = try? SyncCrypto.openRecord(keyring: kr, account: accountId, keyId: kid, collection: collection,
                                                         objectId: oid, revision: UInt64(rev), blob: o.str("blob") ?? ""),
                  let v = try? JSONValue.parse(plain) else { return }
            if v["deleted"]?.bool == true {
                if let id = byId.keys.first(where: { (try? SyncCrypto.objectId(keyring: kr, collection: "chat", localId: $0)) == oid }) {
                    byId[id] = nil
                }
            } else if let c = v["chat"], let id = c.str("id"),
                      // The record must be the one filed under this chat's id: the server can't swap chats.
                      (try? SyncCrypto.objectId(keyring: kr, collection: "chat", localId: id)) == oid {
                let chat = Self.chat(c)
                if byId[id].map({ chat.updatedAt >= $0.updatedAt }) ?? true { byId[id] = chat }
            } else {
                return
            }
        default:
            return
        }
        state.revisions[oid] = rev
    }

    // MARK: The account record

    struct TrustedDevice: Equatable {
        var id: String
        var publicKey: String
        var label: String
    }

    /// The sealed account record of one key epoch: the recovery key's public half and the trusted devices.
    struct AccountRecord: Equatable {
        var epoch: UInt32
        var recoveryPublic: String
        var devices: [TrustedDevice]

        func trusts(_ id: String) -> Bool { devices.contains { $0.id == id } }
        func lists(id: String, publicKey: String) -> Bool { devices.contains { $0.id == id && $0.publicKey == publicKey } }
        mutating func add(_ d: TrustedDevice) {
            devices.removeAll { $0.id == d.id }
            devices.append(d)
        }
    }

    static func accountLocalId(_ epoch: UInt32) -> String { "epoch-\(epoch)" }

    static func accountRecord(_ text: String?) -> AccountRecord? {
        guard let text else { return nil }
        return accountRecord(Data(text.utf8))
    }

    static func accountRecord(_ data: Data) -> AccountRecord? {
        guard let v = try? JSONValue.parse(data), v.long("v") == 2, let e = v.long("epoch").flatMap({ UInt32(exactly: $0) }), e >= 1,
              let rp = v.str("recoveryPublic") else { return nil }
        let devices = (v["devices"]?.array ?? []).compactMap { d -> TrustedDevice? in
            guard let id = d.str("id"), let pk = d.str("publicKey") else { return nil }
            return TrustedDevice(id: id, publicKey: pk, label: d.str("label") ?? "")
        }
        return AccountRecord(epoch: e, recoveryPublic: rp, devices: devices)
    }

    static func accountRecordJSON(_ r: AccountRecord) -> String {
        let devices: [JSONValue] = r.devices.map { .object(["id": .string($0.id), "publicKey": .string($0.publicKey), "label": .string($0.label)]) }
        return JSONValue.object(["v": .int(2), "epoch": .int(Int64(r.epoch)), "recoveryPublic": .string(r.recoveryPublic),
                                 "devices": .array(devices)]).serialized()
    }

    /// Open an epoch's account record and check it: the right object, the
    /// epoch it claims, the pinned recovery key, and not older than one seen.
    private func openAccount(_ o: JSONValue, keyring kr: SyncCrypto.Keyring, accountId: String,
                             epoch: UInt32) throws -> (AccountRecord, String, Int64) {
        let bad = CloudError(message: "Nekko Cloud sent an account record that doesn't check out.")
        let oid = try SyncCrypto.objectId(keyring: kr, collection: "account", localId: Self.accountLocalId(epoch))
        guard o.str("collection") == "account", o.str("objectId") == oid, o.long("keyId") == Int64(epoch),
              let rev = o.long("revision"), rev >= 1,
              let plain = try? SyncCrypto.openRecord(keyring: kr, account: accountId, keyId: epoch, collection: "account",
                                                     objectId: oid, revision: UInt64(rev), blob: o.str("blob") ?? ""),
              let record = Self.accountRecord(plain), record.epoch == epoch else { throw bad }
        // The recovery key's public half never changes; a record naming another one is refused.
        if let pinned = state.recoveryPublic, pinned != record.recoveryPublic { throw bad }
        if let seen = state.revisions[oid], seen > rev {
            throw CloudError(message: "Nekko Cloud sent an older account record than this iPhone has seen.")
        }
        return (record, oid, rev)
    }

    /// An epoch's account record, out of feed order. Nil while it isn't written yet.
    private func fetchAccount(token t: String, keyring kr: SyncCrypto.Keyring, accountId: String,
                              epoch: UInt32) async throws -> (AccountRecord, String, Int64)? {
        let oid = try SyncCrypto.objectId(keyring: kr, collection: "account", localId: Self.accountLocalId(epoch))
        do {
            let o = try await request("GET", path("/v1/sync/objects/account/\(oid)"), token: t)
            return try openAccount(o, keyring: kr, accountId: accountId, epoch: epoch)
        } catch let e as CloudError where e.status == 404 {
            return nil
        }
    }

    private func keepAccount(_ record: AccountRecord, oid: String, revision: Int64) {
        state.recoveryPublic = record.recoveryPublic
        state.accountRecord = Self.accountRecordJSON(record)
        state.revisions[oid] = max(state.revisions[oid] ?? 0, revision)
        save()
    }

    /// Hold a keyring as the current epoch and forget older ones: records under
    /// an older epoch are never accepted again.
    private func holdEpoch(_ epoch: UInt32, _ kr: SyncCrypto.Keyring, record: AccountRecord, oid: String, revision: Int64) {
        let old = state.keyId
        storeKeyring(epoch, kr)
        state.keyId = epoch
        keepAccount(record, oid: oid, revision: revision)
        if let old, old < epoch {
            for k in 1...old { secrets.set("cloud.keyring.\(k)", nil) }
        }
    }

    /// Change the current epoch's account record: apply `change` to the newest
    /// one and push it. Never builds one from nothing (that would drop every
    /// other device), and never takes the server's word for an older revision.
    private func updateAccount(token t: String, _ change: (inout AccountRecord) -> Void) async throws {
        guard let accountId = account?.id, let k = state.keyId, let kr = keyring(k) else {
            throw CloudError(message: "This iPhone doesn't sync yet.")
        }
        let oid = try SyncCrypto.objectId(keyring: kr, collection: "account", localId: Self.accountLocalId(k))
        for _ in 0..<3 {
            guard var record = Self.accountRecord(state.accountRecord), record.epoch == k else {
                throw CloudError(message: "This iPhone hasn't read the account record yet. Sync, then try again.")
            }
            change(&record)
            let seen = state.revisions[oid] ?? 0
            let revision = seen + 1
            let body = Self.accountRecordJSON(record)
            let blob = try SyncCrypto.sealRecord(keyring: kr, account: accountId, keyId: k, collection: "account", objectId: oid,
                                                 revision: UInt64(revision), plaintext: Data(body.utf8))
            let obj: JSONValue = .object(["collection": .string("account"), "objectId": .string(oid), "revision": .int(revision),
                                          "keyId": .int(Int64(k)), "blob": .string(blob)])
            let res = try await request("POST", path("/v1/sync/push"), json: .object(["objects": .array([obj])]), token: t)
            let r = res["results"]?.array?.first
            switch r?.str("status") {
            case "ok":
                keepAccount(record, oid: oid, revision: revision)
                return
            case "conflict":
                if (r?.long("revision") ?? 0) < seen {
                    throw CloudError(message: "Nekko Cloud sent an older account record than this iPhone has seen.")
                }
                if let (rec, o, rev) = try await fetchAccount(token: t, keyring: kr, accountId: accountId, epoch: k) {
                    keepAccount(rec, oid: o, revision: rev)
                }
            default:
                throw CloudError(message: "Couldn't save the account's device list.")
            }
        }
        throw CloudError(message: "Couldn't save the account's device list.")
    }

    // MARK: Helpers

    static let removed = "This iPhone was removed from sync on another device."

    /// This iPhone's key and registered id. Registers (again) when this
    /// sign-in's token isn't bound to it yet, so removing the iPhone always
    /// ends the token it uses.
    private func ensureDevice(token t: String, joinTag: Data?) async throws -> (SyncAgreementKey, String) {
        let device = try key()
        if let id = state.deviceId, boundDevice == id, joinTag == nil { return (device, id) }
        var body: [String: JSONValue] = ["publicKey": .string(SyncCrypto.base64url(device.publicKeyX963)), "label": .string(deviceLabel)]
        if let joinTag { body["joinTag"] = .string(SyncCrypto.base64url(joinTag)) }
        let v: JSONValue
        do {
            v = try await request("POST", path("/v1/sync/devices"), json: .object(body), token: t)
        } catch let e as CloudError where e.code == "token-has-device" {
            throw CloudError(message: "This sign-in already belongs to another device. Sign out and in again.")
        } catch let e as CloudError where e.code == "device-revoked" {
            forgetKeys()
            resetSync()
            throw CloudError(message: "This iPhone was removed from sync. Set sync up again to add it back.")
        }
        guard let id = v.str("deviceId") else { throw CloudError(message: "Nekko Cloud didn't register this iPhone.") }
        if let known = state.deviceId, known != id {
            throw CloudError(message: "Nekko Cloud gave this iPhone a different id. Sign out and in again.")
        }
        state.deviceId = id
        boundDevice = id
        save()
        return (device, id)
    }

    static func account(_ v: JSONValue?) -> Account {
        Account(id: v?.str("id") ?? "", email: v?.str("email") ?? "", plan: v?.str("plan") ?? "free", canSync: v?["canSync"]?.bool ?? false)
    }

    static func chat(_ c: JSONValue) -> Chat {
        let messages: [Message] = (c["messages"]?.array ?? []).compactMap { m in
            let text = m.str("content") ?? m.str("text") ?? ""
            guard !text.isEmpty else { return nil }
            return Message(role: m.str("role") ?? "assistant", text: text)
        }
        return Chat(id: c.str("id") ?? "", title: c.str("title") ?? "Chat", updatedAt: c.dbl("updatedAt") ?? 0, messages: messages)
    }

    static func encodeChats(_ chats: [Chat]) -> JSONValue {
        .array(chats.map { c in
            .object(["id": .string(c.id), "title": .string(c.title), "updatedAt": .double(c.updatedAt),
                     "messages": .array(c.messages.map { .object(["role": .string($0.role), "content": .string($0.text)]) })])
        })
    }

    static func decodeChats(_ v: JSONValue?) -> [Chat] { (v?.array ?? []).map(chat) }

    private func keyring(_ id: UInt32) -> SyncCrypto.Keyring? {
        secrets.get("cloud.keyring.\(id)").flatMap { try? SyncCrypto.fromBase64url($0) }.flatMap { try? SyncCrypto.Keyring(bytes: $0) }
    }

    private func storeKeyring(_ id: UInt32, _ k: SyncCrypto.Keyring) {
        secrets.set("cloud.keyring.\(id)", SyncCrypto.base64url(k.bytes))
    }

    private func forgetKeys() {
        for k in 1...max(1, state.keyId ?? 1) { secrets.set("cloud.keyring.\(k)", nil) }
        secrets.set("cloud.joinCode", nil)
        joinCode = nil
        chats = []
        files?.remove("cloud")
    }

    /// Forget sync (keys already gone), keeping the sign-in.
    private func resetSync() {
        state = State(account: state.account, keysAccount: state.account?.id)
        waitingForApproval = false
        save()
    }

    /// Forget this iPhone's sync: keys, synced chats and sign-in (Settings → Forget everything).
    public func forgetAll() {
        forgetKeys()
        secrets.set("cloud.token", nil)
        state = State()
        account = nil
        devices = []
        waitingForApproval = false
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(state) { secrets.set("cloud.state", String(decoding: data, as: UTF8.self)) }
    }

    // MARK: Nekko Cloud machines (decision 0017)

    /// A sandboxed machine on the account, as Nekko Cloud lists it.
    public struct Machine: Identifiable, Equatable, Sendable {
        public let id: String
        public var name: String
        public let region: String
        public var state: String
        public let room: String
        public var scope: MachineScope
        public var hoursUsed: Double
        public var hoursIncluded: Double

        public static func from(_ v: JSONValue?) -> Machine? {
            guard let v, let id = v.str("id") else { return nil }
            return Machine(id: id, name: v.str("name") ?? "Nekko Cloud", region: v.str("region") ?? "", state: v.str("state") ?? "",
                           room: v.str("room") ?? "", scope: MachineScope.from(v["scope"]), hoursUsed: v.dbl("hoursUsed") ?? 0,
                           hoursIncluded: v.dbl("hoursIncluded") ?? 0)
        }
    }

    /// What the phone lets the cloud see: minimal by default.
    public struct MachineScope: Equatable, Sendable {
        public var repos: [String] = []
        public var privacyShield = true
        public var memory = false
        public var syncBack = true

        public init(repos: [String] = [], privacyShield: Bool = true, memory: Bool = false, syncBack: Bool = true) {
            self.repos = repos
            self.privacyShield = privacyShield
            self.memory = memory
            self.syncBack = syncBack
        }

        public static func from(_ v: JSONValue?) -> MachineScope {
            MachineScope(repos: (v?["repos"]?.array ?? []).compactMap(\.string),
                         privacyShield: v?["privacyShield"]?.bool ?? true, memory: v?.flag("memory") ?? false, syncBack: v?["syncBack"]?.bool ?? true)
        }

        public var json: JSONValue {
            .object(["repos": .array(repos.map(JSONValue.string)), "privacyShield": .bool(privacyShield), "memory": .bool(memory), "syncBack": .bool(syncBack)])
        }
    }

    public private(set) var machines: [Machine] = []
    /// The relay Nekko Cloud's machines meet the phone on.
    public private(set) var machinesRelay: String?
    /// Machine id → the paired computer's id on this iPhone (kept in the Keychain beside the token).
    public private(set) var machineLinks: [String: String] = [:]

    private static func decodeLinks(_ raw: String?) -> [String: String] {
        guard let raw, let v = try? JSONValue.parse(raw), let o = v.object else { return [:] }
        return o.compactMapValues(\.string)
    }

    private func loadLinks() { machineLinks = Self.decodeLinks(secrets.get("cloud.machines")) }

    private func saveLinks() {
        secrets.set("cloud.machines", JSONValue.object(machineLinks.mapValues(JSONValue.string)).serialized())
    }

    /// The machine a paired computer on this iPhone is, if it is one.
    public func machine(forComputer computerId: String) -> Machine? {
        guard let id = machineLinks.first(where: { $0.value == computerId })?.key else { return nil }
        return machines.first { $0.id == id }
    }

    /// The computer id a machine was paired as on this iPhone.
    public func computerId(for machine: Machine) -> String? { machineLinks[machine.id] }

    public func loadMachines() async throws {
        loadLinks()
        let v = try await request("GET", path("/v1/machines"), token: token())
        machines = (v["machines"]?.array ?? []).compactMap(Machine.from)
        machinesRelay = v.str("relayUrl")
    }

    /// Make a machine. Nekko Cloud answers the pairing link once; the caller
    /// pairs it like any computer and records the link with `link(_:computer:)`.
    public func createMachine(name: String, region: String, scope: MachineScope) async throws -> (machine: Machine, link: PairingLink) {
        let body: JSONValue = .object(["name": .string(name), "region": .string(region), "scope": scope.json])
        let v = try await request("POST", path("/v1/machines"), json: body, token: token())
        guard let m = Machine.from(v["machine"]), let raw = v.str("pairingLink"), let link = Pairing.parse(raw) else {
            throw CloudError(message: "Nekko Cloud didn’t answer with a machine to pair.")
        }
        machines.append(m)
        return (m, link)
    }

    public func link(_ machine: Machine, computer computerId: String) {
        machineLinks[machine.id] = computerId
        saveLinks()
    }

    public func setScope(_ machine: Machine, _ scope: MachineScope) async throws {
        let v = try await request("PUT", path("/v1/machines/\(machine.id)/scope"), json: scope.json, token: token())
        if let m = Machine.from(v["machine"]), let i = machines.firstIndex(where: { $0.id == m.id }) { machines[i] = m }
    }

    public func stopMachine(_ machine: Machine) async throws {
        let v = try await request("POST", path("/v1/machines/\(machine.id)/stop"), token: token())
        if let m = Machine.from(v["machine"]), let i = machines.firstIndex(where: { $0.id == m.id }) { machines[i] = m }
    }

    public func startMachine(_ machine: Machine) async throws {
        let v = try await request("POST", path("/v1/machines/\(machine.id)/start"), token: token())
        if let m = Machine.from(v["machine"]), let i = machines.firstIndex(where: { $0.id == m.id }) { machines[i] = m }
    }

    /// Delete the machine, its disk and its pairing on Nekko Cloud; the caller forgets the computer here.
    public func deleteMachine(_ machine: Machine) async throws {
        try await request("DELETE", path("/v1/machines/\(machine.id)"), token: token())
        machines.removeAll { $0.id == machine.id }
        machineLinks[machine.id] = nil
        saveLinks()
    }

    private func token() throws -> String {
        guard let t = secrets.get("cloud.token") else { throw CloudError(message: "Sign in to Nekko Cloud first.") }
        return t
    }

    private func path(_ p: String) -> URL { URL(string: api.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + p)! }

    private func supabaseConfig() async throws -> (url: String, anon: String) {
        if let s = supabase { return s }
        let v: JSONValue
        do { v = try await request("GET", path("/v1/auth/config")) } catch let e as CloudError where e.code == "sign-in-not-configured" {
            throw CloudError(message: "Nekko Cloud sign-in isn't switched on yet.")
        }
        guard let url = v.str("supabaseUrl"), let anon = v.str("supabaseAnonKey") else { throw CloudError(message: "Nekko Cloud sent no sign-in settings.") }
        supabase = (url.trimmingCharacters(in: CharacterSet(charactersIn: "/")), anon)
        return supabase!
    }

    @discardableResult
    private func request(_ method: String, _ url: URL, json: JSONValue? = nil, token: String? = nil, headers: [String: String] = [:]) async throws -> JSONValue {
        var h = headers
        if let token { h["Authorization"] = "Bearer \(token)" }
        if json != nil { h["Content-Type"] = "application/json" }
        let (status, data) = try await http.send(method, url, headers: h, body: json.map { Data($0.serialized().utf8) })
        let v = (try? JSONValue.parse(data)) ?? .null
        guard (200..<300).contains(status) else {
            let code = v.str("error") ?? v.str("error_code") ?? ""
            let message = v.str("message") ?? v.str("msg") ?? (status == 402 ? "Sync needs a Pro or Team plan." : status == 401 ? "You're signed out of Nekko Cloud." : "Nekko Cloud answered \(status).")
            throw CloudError(status: status, code: code, message: message)
        }
        return v
    }
}

public struct CloudError: Error, Equatable, LocalizedError {
    public var status = 0
    public var code = ""
    public var message: String
    public var errorDescription: String? { message }
}

/// HTTP for the cloud model, so tests can answer without a network.
public protocol CloudHTTP: Sendable {
    func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data)
}

public struct URLSessionCloudHTTP: CloudHTTP {
    public init() {}

    public func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data) {
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = method
        req.httpBody = body
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        let (data, res) = try await URLSession.shared.data(for: req)
        return ((res as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

extension CloudSync.Account: Codable {}
