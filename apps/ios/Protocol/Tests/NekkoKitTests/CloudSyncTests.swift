import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// The iPhone's side of Nekko Cloud against an in-memory Nekko Cloud and
/// Supabase Auth. The "computer" that turned sync on is played by the test
/// with `SyncCrypto`, the way `crates/nekko-cloud` seals records.
@MainActor
final class CloudSyncTests: XCTestCase {
    final class MemorySecrets: SecureStore, @unchecked Sendable {
        var items: [String: String] = [:]
        func get(_ key: String) -> String? { items[key] }
        func set(_ key: String, _ value: String?) { items[key] = value }
    }

    /// Just enough of the API for the phone's calls.
    final class FakeCloud: CloudHTTP, @unchecked Sendable {
        let account = "acct-1"
        var plan = "pro"
        var keyrings: [UInt32: (recovery: String, wraps: [String: String])] = [:]
        var devices: [(id: String, publicKey: String, label: String)] = []
        var objects: [(collection: String, objectId: String, revision: Int64, keyId: UInt32, blob: String, seq: Int64)] = []
        var seq: Int64 = 0
        let lock = NSLock()

        func add(_ collection: String, _ oid: String, _ rev: Int64, _ keyId: UInt32, _ blob: String) {
            lock.lock(); defer { lock.unlock() }
            seq += 1
            objects.removeAll { $0.objectId == oid && $0.collection == collection }
            objects.append((collection, oid, rev, keyId, blob, seq))
        }

        func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data) {
            let p = url.path
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let b = body.flatMap { try? JSONValue.parse($0) } ?? .null
            func ok(_ v: JSONValue) -> (Int, Data) { (200, Data(v.serialized().utf8)) }
            switch (method, p) {
            case ("GET", "/v1/auth/config"):
                return ok(.object(["supabaseUrl": .string("https://sb.example"), "supabaseAnonKey": .string("anon")]))
            case ("POST", "/auth/v1/otp"):
                return ok(.object([:]))
            case ("POST", "/auth/v1/verify"):
                if b.str("token") != "123456" { return (403, Data(#"{"msg":"bad"}"#.utf8)) }
                return ok(.object(["access_token": .string("supabase-jwt")]))
            case ("POST", "/v1/auth/session"):
                return ok(.object(["token": .string("nk_test"), "account": me()]))
            case ("GET", "/v1/auth/me"):
                return ok(.object(["account": me()]))
            case ("GET", "/v1/sync/state"):
                let ds: [JSONValue] = devices.map { .object(["id": .string($0.id), "publicKey": .string($0.publicKey), "label": .string($0.label), "revokedAt": .null]) }
                return ok(.object(["currentKeyId": keyrings.keys.max().map { .int(Int64($0)) } ?? .null, "devices": .array(ds)]))
            case ("POST", "/v1/sync/devices"):
                let id = "dev-\(devices.count + 1)"
                devices.append((id, b.str("publicKey") ?? "", b.str("label") ?? ""))
                return (201, Data(JSONValue.object(["deviceId": .string(id)]).serialized().utf8))
            case ("GET", "/v1/sync/pull"):
                let since = Int64(q.first { $0.name == "since" }?.value ?? "0") ?? 0
                let page = objects.filter { $0.seq > since }.sorted { $0.seq < $1.seq }
                let objs: [JSONValue] = page.map { .object(["collection": .string($0.collection), "objectId": .string($0.objectId), "revision": .int($0.revision),
                                                            "keyId": .int(Int64($0.keyId)), "blob": .string($0.blob), "seq": .int($0.seq)]) }
                return ok(.object(["objects": .array(objs), "next": .int(page.last?.seq ?? since), "more": .bool(false)]))
            case ("POST", "/v1/sync/push"):
                var results: [JSONValue] = []
                for o in b["objects"]?.array ?? [] {
                    add(o.str("collection") ?? "", o.str("objectId") ?? "", o.long("revision") ?? 0, UInt32(o.long("keyId") ?? 0), o.str("blob") ?? "")
                    results.append(.object(["status": .string("ok")]))
                }
                return ok(.object(["results": .array(results)]))
            case ("DELETE", "/v1/auth/session"):
                return (204, Data())
            default:
                let parts = p.split(separator: "/").map(String.init) // v1 sync keyrings K [wraps D]
                if parts.count >= 4, parts[2] == "keyrings", let k = UInt32(parts[3]) {
                    if method == "GET" {
                        let ring = keyrings[k]!
                        let dev = devices.last?.id ?? ""
                        return ok(.object(["recoveryWrap": .string(ring.recovery), "wrap": ring.wraps[dev].map { .string($0) } ?? .null]))
                    }
                    if method == "PUT", parts.count == 6 {
                        keyrings[k]!.wraps[parts[5]] = b.str("wrap")
                        return (204, Data())
                    }
                }
                return (404, Data(#"{"error":"not-found"}"#.utf8))
            }
        }

        func me() -> JSONValue {
            .object(["id": .string(account), "email": .string("ada@example.com"), "plan": .string(plan), "canSync": .bool(plan != "free")])
        }
    }

    /// A computer that turned sync on: keyring, recovery key, account record and two chats.
    func computer(_ fake: FakeCloud) throws -> (SyncCrypto.Keyring, SyncCrypto.RecoveryKey) {
        let keyring = SyncCrypto.Keyring.generate()
        let recovery = SyncCrypto.RecoveryKey.generate()
        let rp = SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963
        fake.keyrings[1] = (try SyncCrypto.sealRecovery(recoveryPublic: rp, keyring: keyring, account: fake.account, keyId: 1), [:])
        fake.devices.append(("dev-mac", SyncCrypto.base64url(SyncCrypto.SoftwareKey().publicKeyX963), "Studio Mac"))
        let record = #"{"v":1,"recoveryPublic":"\#(SyncCrypto.base64url(rp))","devices":[]}"#
        let aoid = try SyncCrypto.objectId(keyring: keyring, collection: "account", localId: "account")
        fake.add("account", aoid, 1, 1, try SyncCrypto.sealRecord(keyring: keyring, account: fake.account, keyId: 1, collection: "account", objectId: aoid, revision: 1, plaintext: Data(record.utf8)))
        try sealChat(fake, keyring, id: "s_1", title: "Plan the Kyoto trip", text: "Book the ryokan", updated: 10, rev: 1)
        try sealChat(fake, keyring, id: "s_2", title: "Fix the flaky test", text: "It's a race", updated: 20, rev: 1)
        return (keyring, recovery)
    }

    func sealChat(_ fake: FakeCloud, _ k: SyncCrypto.Keyring, id: String, title: String, text: String, updated: Double, rev: Int64, oid: String? = nil) throws {
        let chat = #"{"v":1,"chat":{"id":"\#(id)","title":"\#(title)","updatedAt":\#(updated),"messages":[{"role":"user","content":"\#(text)"}]}}"#
        let o = try oid ?? SyncCrypto.objectId(keyring: k, collection: "chat", localId: id)
        fake.add("chat", o, rev, 1, try SyncCrypto.sealRecord(keyring: k, account: fake.account, keyId: 1, collection: "chat", objectId: o, revision: UInt64(rev), plaintext: Data(chat.utf8)))
    }

    func phone(_ fake: FakeCloud, key: SyncCrypto.SoftwareKey = SyncCrypto.SoftwareKey()) -> CloudSync {
        CloudSync(api: URL(string: "https://api.example")!, http: fake, secrets: MemorySecrets(), files: nil, deviceLabel: "iPhone", key: { key })
    }

    func testSignInThenRestoreWithTheRecoveryKeyReadsTheChats() async throws {
        let fake = FakeCloud()
        let (_, recovery) = try computer(fake)
        let p = phone(fake)
        XCTAssertEqual(p.phase, .signedOut)
        try await p.sendCode(email: "ada@example.com")
        do { try await p.verifyCode(email: "ada@example.com", code: "000000"); XCTFail("a wrong code signs in") } catch {}
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        XCTAssertEqual(p.phase, .needsJoin)
        do { try await p.restore(recoveryKey: SyncCrypto.RecoveryKey.generate().text); XCTFail("another account's key opens it") } catch {}
        try await p.restore(recoveryKey: recovery.text.lowercased())
        XCTAssertEqual(p.phase, .idle)
        XCTAssertEqual(p.chats.map(\.title), ["Fix the flaky test", "Plan the Kyoto trip"])
        XCTAssertEqual(p.chats.last?.messages.first?.text, "Book the ryokan")
        // The phone added itself to the sealed device list.
        XCTAssertTrue(p.devices.first { $0.thisDevice }?.trusted == true)
    }

    func testJoiningByApprovalOnTheComputer() async throws {
        let fake = FakeCloud()
        let (keyring, _) = try computer(fake)
        let key = SyncCrypto.SoftwareKey()
        let p = phone(fake, key: key)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.requestJoin()
        XCTAssertEqual(p.phase, .awaitingApproval)
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice })
        XCTAssertEqual(me.fingerprint, p.fingerprint, "the computer shows the same code")
        try await p.sync()
        XCTAssertEqual(p.phase, .awaitingApproval, "nothing to open until approved")
        // The computer approves: it wraps the keyring to the phone's public key.
        fake.keyrings[1]!.wraps[me.id] = try SyncCrypto.wrapKeyring(keyring, account: fake.account, keyId: 1, deviceId: me.id, devicePublic: key.publicKeyX963)
        try await p.sync()
        XCTAssertEqual(p.phase, .idle)
        XCTAssertEqual(p.chats.count, 2)
    }

    func testTamperedSwappedAndRolledBackRecordsAreIgnored() async throws {
        let fake = FakeCloud()
        let (keyring, recovery) = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: recovery.text)
        // A newer revision of s_1 lands; then the server replays the old one (rollback).
        try sealChat(fake, keyring, id: "s_1", title: "Plan the Kyoto trip", text: "Changed plans", updated: 30, rev: 2)
        try await p.sync()
        XCTAssertEqual(p.chats.first { $0.id == "s_1" }?.messages.first?.text, "Changed plans")
        try sealChat(fake, keyring, id: "s_1", title: "Plan the Kyoto trip", text: "Book the ryokan", updated: 10, rev: 1)
        try await p.sync()
        XCTAssertEqual(p.chats.first { $0.id == "s_1" }?.messages.first?.text, "Changed plans", "a replayed old revision is ignored")
        // A chat filed under another chat's id (the server swapping records) is refused.
        let s2 = try SyncCrypto.objectId(keyring: keyring, collection: "chat", localId: "s_2")
        try sealChat(fake, keyring, id: "s_9", title: "Planted", text: "x", updated: 99, rev: 2, oid: s2)
        // A flipped bit doesn't open.
        let o = try SyncCrypto.objectId(keyring: keyring, collection: "chat", localId: "s_3")
        var raw = try SyncCrypto.fromBase64url(try SyncCrypto.sealRecord(keyring: keyring, account: fake.account, keyId: 1, collection: "chat", objectId: o, revision: 1,
                                                                      plaintext: Data(#"{"v":1,"chat":{"id":"s_3","title":"T","updatedAt":1,"messages":[]}}"#.utf8)))
        raw[40] ^= 1
        fake.add("chat", o, 1, 1, SyncCrypto.base64url(raw))
        try await p.sync()
        XCTAssertEqual(Set(p.chats.map(\.id)), ["s_1", "s_2"])
    }

    func testFreeAccountsAreAskedToUpgradeAndUnsetAccountsToStartOnTheComputer() async throws {
        let fake = FakeCloud()
        fake.plan = "free"
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        XCTAssertEqual(p.phase, .needsPlan)
        fake.plan = "pro"
        try await p.refresh()
        XCTAssertEqual(p.phase, .notSetUp)
        await p.signOut()
        XCTAssertEqual(p.phase, .signedOut)
    }

    func testThePkceChallengeIsS256() async throws {
        let p = phone(FakeCloud())
        let (url, verifier) = try await p.oauthStart(provider: "github")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, SyncCrypto.pkceChallenge(verifier))
        XCTAssertEqual(items.first { $0.name == "redirect_to" }?.value, CloudSync.oauthRedirect)
        XCTAssertEqual(url.path, "/auth/v1/authorize")
    }
}
