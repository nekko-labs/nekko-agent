import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import NekkoProtocol
import Observation

/// Nekko Cloud on the iPhone: sign in (Supabase Auth proves who you are, the
/// device token comes from Nekko Cloud), join the account's end-to-end
/// encrypted sync with the recovery key or by being approved on a computer,
/// approve a new computer from here, and read the synced chats without the
/// computer online. The phone reads sync; it doesn't write chats (they live on
/// the computer that runs them).
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

    /// This iPhone's code, to compare on the computer that approves it.
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
            throw CloudError(message: items.first(where: { $0.name == "error_description" })?.value ?? "The sign-in came back without a code.")
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
        if let old = state.account, old.id != a.id {
            forgetKeys()
            state = State()
        }
        secrets.set("cloud.token", token)
        state.account = a
        account = a
        save()
        try? await refresh()
    }

    public func signOut() async {
        if let t = secrets.get("cloud.token") {
            _ = try? await request("DELETE", path("/v1/auth/session"), token: t)
        }
        secrets.set("cloud.token", nil)
        state.account = nil
        account = nil
        devices = []
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
        remoteKeyId = remote.long("currentKeyId").map { UInt32($0) }
        let trusted = Self.trustedIds(state.accountRecord)
        devices = (remote["devices"]?.array ?? []).compactMap { d in
            guard let id = d.str("id") else { return nil }
            let pk = d.str("publicKey").flatMap { try? SyncCrypto.fromBase64url($0) } ?? Data()
            return Device(id: id, label: d.str("label") ?? "Device", fingerprint: SyncCrypto.fingerprint(publicKey: pk),
                          revoked: !(d["revokedAt"]?.isNull ?? true), trusted: trusted.contains(id), thisDevice: id == state.deviceId)
        }
        save()
    }

    // MARK: Joining

    /// Register this iPhone and wait for a computer to approve it.
    public func requestJoin() async throws {
        let t = try token()
        _ = try await ensureDevice(token: t)
        state.waiting = true
        waitingForApproval = true
        save()
        try await refresh()
    }

    /// Join with the recovery key: open every key epoch's recovery wrap.
    public func restore(recoveryKey text: String) async throws {
        let t = try token()
        let rk: SyncCrypto.RecoveryKey
        do { rk = try SyncCrypto.RecoveryKey(text: text) } catch { throw CloudError(message: "That isn't a valid recovery key. Check it for typos.") }
        try await refresh()
        guard let accountId = account?.id else { throw CloudError(message: "Sign in first.") }
        let remote = try await request("GET", path("/v1/sync/state"), token: t)
        guard let current = remote.long("currentKeyId").map({ UInt32($0) }) else {
            throw CloudError(message: "This account doesn't sync yet. Turn sync on on your computer first.")
        }
        let (device, deviceId) = try await ensureDevice(token: t)
        for k in 1...current {
            let ring = try await request("GET", path("/v1/sync/keyrings/\(k)"), token: t)
            let keyring: SyncCrypto.Keyring
            do {
                keyring = try SyncCrypto.openRecovery(rk, account: accountId, keyId: k, blob: ring.str("recoveryWrap") ?? "")
            } catch {
                throw CloudError(message: "That recovery key doesn't belong to this account.")
            }
            let wrap = try SyncCrypto.wrapKeyring(keyring, account: accountId, keyId: k, deviceId: deviceId, devicePublic: device.publicKeyX963)
            _ = try await request("PUT", path("/v1/sync/keyrings/\(k)/wraps/\(deviceId)"), json: .object(["wrap": .string(wrap)]), token: t)
            storeKeyring(k, keyring)
        }
        state.keyId = current
        state.recoveryPublic = SyncCrypto.base64url(SyncCrypto.recoveryAgreementKey(rk).publicKeyX963)
        state.waiting = false
        waitingForApproval = false
        save()
        try await sync()
        try await trustSelf(device: device, deviceId: deviceId)
        try await refresh()
    }

    /// On this iPhone, approve a computer that asked to join (after comparing its code).
    public func approve(deviceId: String) async throws {
        let t = try token()
        guard let accountId = account?.id, let top = state.keyId else { throw CloudError(message: "This iPhone doesn't sync yet.") }
        let remote = try await request("GET", path("/v1/sync/state"), token: t)
        guard let d = remote["devices"]?.array?.first(where: { $0.str("id") == deviceId }),
              let pk = d.str("publicKey").flatMap({ try? SyncCrypto.fromBase64url($0) }) else {
            throw CloudError(message: "That device isn't on this account.")
        }
        for k in 1...top {
            guard let kr = keyring(k) else { continue }
            let wrap = try SyncCrypto.wrapKeyring(kr, account: accountId, keyId: k, deviceId: deviceId, devicePublic: pk)
            _ = try await request("PUT", path("/v1/sync/keyrings/\(k)/wraps/\(deviceId)"), json: .object(["wrap": .string(wrap)]), token: t)
        }
        var record = Self.accountRecord(state.accountRecord) ?? (state.recoveryPublic ?? "", [])
        record.devices.removeAll { $0.id == deviceId }
        record.devices.append((deviceId, SyncCrypto.base64url(pk), d.str("label") ?? ""))
        try await pushAccount(record, token: t)
        try await refresh()
    }

    // MARK: Sync (read)

    public func sync() async throws {
        let t = try token()
        syncing = true
        defer { syncing = false }
        do {
            try await refresh()
            if !hasKeys || accountSyncsNewerEpoch() {
                try await takeWraps(token: t)
                guard hasKeys else { return }
            }
            try await pull(token: t)
            error = nil
            lastSyncAt = Date()
        } catch {
            self.error = (error as? CloudError)?.message ?? error.localizedDescription
            throw error
        }
    }

    /// A computer rotated to a new key epoch (after removing a device): take this iPhone's wrap of it.
    private func accountSyncsNewerEpoch() -> Bool {
        guard let remote = remoteKeyId, let mine = state.keyId else { return false }
        return remote > mine
    }

    /// The keyrings a computer wrapped to this iPhone, once it approved it.
    private func takeWraps(token t: String) async throws {
        guard let accountId = account?.id, let deviceId = state.deviceId else { return }
        let device = try key()
        let remote = try await request("GET", path("/v1/sync/state"), token: t)
        guard let current = remote.long("currentKeyId").map({ UInt32($0) }) else { return }
        var got: UInt32 = 0
        for k in 1...current {
            let ring = try await request("GET", path("/v1/sync/keyrings/\(k)"), token: t)
            if let w = ring.str("wrap"), let kr = try? SyncCrypto.unwrapKeyring(key: device, account: accountId, keyId: k, deviceId: deviceId, wrap: w) {
                storeKeyring(k, kr)
                got = k
            }
        }
        if got == current {
            state.keyId = current
            state.waiting = false
            waitingForApproval = false
            save()
        }
    }

    private func pull(token t: String) async throws {
        guard let accountId = account?.id else { return }
        var byId = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, $0) })
        while true {
            let page = try await request("GET", path("/v1/sync/pull?since=\(state.cursor)&limit=200"), token: t)
            let objects = page["objects"]?.array ?? []
            for o in objects { apply(o, accountId: accountId, into: &byId) }
            state.cursor = page.long("next") ?? state.cursor
            if page["more"]?.bool != true || objects.isEmpty { break }
        }
        chats = byId.values.sorted { $0.updatedAt > $1.updatedAt }
        files?.save("cloud", "chats", Self.encodeChats(chats))
        save()
    }

    /// Open one pulled object; anything that doesn't open, or is an older revision than one seen (a rollback), is ignored.
    func apply(_ o: JSONValue, accountId: String, into byId: inout [String: Chat]) {
        guard let collection = o.str("collection"), let oid = o.str("objectId"), let rev = o.long("revision"),
              let kid = o.long("keyId").map({ UInt32($0) }), let blob = o.str("blob") else { return }
        if let seen = state.revisions[oid], seen >= rev { return }
        guard let kr = keyring(kid),
              let plain = try? SyncCrypto.openRecord(keyring: kr, account: accountId, keyId: kid, collection: collection,
                                                     objectId: oid, revision: UInt64(rev), blob: blob),
              let v = try? JSONValue.parse(plain) else { return }
        switch collection {
        case "account":
            guard (try? SyncCrypto.objectId(keyring: kr, collection: "account", localId: "account")) == oid,
                  let rp = v.str("recoveryPublic") else { return }
            // The recovery key's public half never changes; a record naming another one is refused.
            if let pinned = state.recoveryPublic, pinned != rp { return }
            state.recoveryPublic = rp
            state.accountRecord = String(decoding: plain, as: UTF8.self)
        case "chat":
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

    // MARK: Helpers

    private func ensureDevice(token t: String) async throws -> (SyncAgreementKey, String) {
        let device = try key()
        if let id = state.deviceId { return (device, id) }
        let v: JSONValue
        do {
            v = try await request("POST", path("/v1/sync/devices"),
                                  json: .object(["publicKey": .string(SyncCrypto.base64url(device.publicKeyX963)), "label": .string(deviceLabel)]), token: t)
        } catch let e as CloudError where e.code == "token-has-device" {
            throw CloudError(message: "This sign-in already belongs to another device. Sign out and in again.")
        }
        guard let id = v.str("deviceId") else { throw CloudError(message: "Nekko Cloud didn't register this iPhone.") }
        state.deviceId = id
        save()
        return (device, id)
    }

    private func trustSelf(device: SyncAgreementKey, deviceId: String) async throws {
        var record = Self.accountRecord(state.accountRecord) ?? (state.recoveryPublic ?? "", [])
        record.devices.removeAll { $0.id == deviceId }
        record.devices.append((deviceId, SyncCrypto.base64url(device.publicKeyX963), deviceLabel))
        try await pushAccount(record, token: try token())
    }

    private func pushAccount(_ record: (recoveryPublic: String, devices: [(id: String, publicKey: String, label: String)]), token t: String) async throws {
        guard let accountId = account?.id, let k = state.keyId, let kr = keyring(k) else { return }
        let oid = try SyncCrypto.objectId(keyring: kr, collection: "account", localId: "account")
        let body = Self.accountRecordJSON(record)
        for _ in 0..<2 {
            let revision = (state.revisions[oid] ?? 0) + 1
            let blob = try SyncCrypto.sealRecord(keyring: kr, account: accountId, keyId: k, collection: "account", objectId: oid,
                                                 revision: UInt64(revision), plaintext: Data(body.utf8))
            let obj: JSONValue = .object(["collection": .string("account"), "objectId": .string(oid), "revision": .int(revision),
                                          "keyId": .int(Int64(k)), "blob": .string(blob)])
            let res = try await request("POST", path("/v1/sync/push"), json: .object(["objects": .array([obj])]), token: t)
            let r = res["results"]?.array?.first
            if r?.str("status") == "ok" {
                state.revisions[oid] = revision
                state.accountRecord = body
                save()
                return
            }
            if r?.str("status") == "conflict" { state.revisions[oid] = r?.long("revision") ?? 0; continue }
            break
        }
        throw CloudError(message: "Couldn't save the account's device list.")
    }

    static func accountRecord(_ text: String?) -> (recoveryPublic: String, devices: [(id: String, publicKey: String, label: String)])? {
        guard let text, let v = try? JSONValue.parse(text), let rp = v.str("recoveryPublic") else { return nil }
        let devices = (v["devices"]?.array ?? []).compactMap { d -> (id: String, publicKey: String, label: String)? in
            guard let id = d.str("id"), let pk = d.str("publicKey") else { return nil }
            return (id, pk, d.str("label") ?? "")
        }
        return (rp, devices)
    }

    static func accountRecordJSON(_ r: (recoveryPublic: String, devices: [(id: String, publicKey: String, label: String)])) -> String {
        let devices: [JSONValue] = r.devices.map { .object(["id": .string($0.id), "publicKey": .string($0.publicKey), "label": .string($0.label)]) }
        return JSONValue.object(["v": .int(1), "recoveryPublic": .string(r.recoveryPublic), "devices": .array(devices)]).serialized()
    }

    static func trustedIds(_ record: String?) -> Set<String> { Set(accountRecord(record)?.devices.map(\.id) ?? []) }

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
        chats = []
        files?.remove("cloud")
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
