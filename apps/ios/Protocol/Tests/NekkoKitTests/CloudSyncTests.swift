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

    /// Just enough of the API for the phone's calls, with the server's rules
    /// (revisions one at a time, wraps never overwritten). Tests also play a
    /// malicious server by editing its state or setting `rewrite`.
    final class FakeCloud: CloudHTTP, @unchecked Sendable {
        var account = "acct-1"
        var plan = "pro"
        var keyrings: [UInt32: (recovery: String, wraps: [String: String])] = [:]
        var devices: [(id: String, publicKey: String, label: String, joinTag: String?)] = []
        var objects: [(collection: String, objectId: String, revision: Int64, keyId: UInt32, blob: String, seq: Int64)] = []
        var seq: Int64 = 0
        /// The device the phone's token is bound to.
        var bound: String?
        /// Change an answer before the phone sees it: (method, path, body).
        var rewrite: ((String, String, inout JSONValue) -> Void)?
        let lock = NSLock()

        func add(_ collection: String, _ oid: String, _ rev: Int64, _ keyId: UInt32, _ blob: String) {
            lock.lock(); defer { lock.unlock() }
            seq += 1
            objects.removeAll { $0.objectId == oid && $0.collection == collection }
            objects.append((collection, oid, rev, keyId, blob, seq))
        }

        func wire(_ o: (collection: String, objectId: String, revision: Int64, keyId: UInt32, blob: String, seq: Int64)) -> JSONValue {
            .object(["collection": .string(o.collection), "objectId": .string(o.objectId), "revision": .int(o.revision),
                     "keyId": .int(Int64(o.keyId)), "blob": .string(o.blob), "seq": .int(o.seq)])
        }

        func send(_ method: String, _ url: URL, headers: [String: String], body: Data?) async throws -> (Int, Data) {
            let (status, answered) = answer(method, url, body: body)
            var v = answered
            rewrite?(method, url.path, &v)
            return (status, Data(v.serialized().utf8))
        }

        func answer(_ method: String, _ url: URL, body: Data?) -> (Int, JSONValue) {
            let p = url.path
            let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let b = body.flatMap { try? JSONValue.parse($0) } ?? .null
            let notFound: (Int, JSONValue) = (404, .object(["error": .string("not-found")]))
            switch (method, p) {
            case ("GET", "/v1/auth/config"):
                return (200, .object(["supabaseUrl": .string("https://sb.example"), "supabaseAnonKey": .string("anon")]))
            case ("POST", "/auth/v1/otp"):
                return (200, .object([:]))
            case ("POST", "/auth/v1/verify"):
                if b.str("token") != "123456" { return (403, .object(["msg": .string("bad")])) }
                return (200, .object(["access_token": .string("supabase-jwt")]))
            case ("POST", "/v1/auth/session"):
                bound = nil
                return (201, .object(["token": .string("nk_test"), "account": me()]))
            case ("GET", "/v1/auth/me"):
                return (200, .object(["account": me()]))
            case ("GET", "/v1/sync/state"):
                let ds: [JSONValue] = devices.map {
                    .object(["id": .string($0.id), "publicKey": .string($0.publicKey), "label": .string($0.label), "revokedAt": .null,
                             "joinTag": $0.joinTag.map { .string($0) } ?? .null])
                }
                return (200, .object(["account": .string(account), "currentKeyId": keyrings.keys.max().map { .int(Int64($0)) } ?? .null,
                                      "device": bound.map { .string($0) } ?? .null, "devices": .array(ds)]))
            case ("POST", "/v1/sync/devices"):
                let pk = b.str("publicKey") ?? ""
                if let i = devices.firstIndex(where: { $0.publicKey == pk }) {
                    if let tag = b.str("joinTag") { devices[i].joinTag = tag }
                    bound = devices[i].id
                    return (200, .object(["deviceId": .string(devices[i].id)]))
                }
                let id = "dev-\(devices.count + 1)"
                devices.append((id, pk, b.str("label") ?? "", b.str("joinTag")))
                bound = id
                return (201, .object(["deviceId": .string(id)]))
            case ("GET", "/v1/sync/pull"):
                let since = Int64(q.first { $0.name == "since" }?.value ?? "0") ?? 0
                let page = objects.filter { $0.seq > since }.sorted { $0.seq < $1.seq }
                return (200, .object(["objects": .array(page.map(wire)), "next": .int(page.last?.seq ?? since), "more": .bool(false)]))
            case ("POST", "/v1/sync/push"):
                var results: [JSONValue] = []
                for o in b["objects"]?.array ?? [] {
                    let (c, oid, rev) = (o.str("collection") ?? "", o.str("objectId") ?? "", o.long("revision") ?? 0)
                    let have = objects.first { $0.collection == c && $0.objectId == oid }?.revision ?? 0
                    if rev != have + 1 {
                        results.append(.object(["objectId": .string(oid), "status": .string("conflict"), "revision": .int(have)]))
                        continue
                    }
                    add(c, oid, rev, UInt32(o.long("keyId") ?? 0), o.str("blob") ?? "")
                    results.append(.object(["objectId": .string(oid), "status": .string("ok"), "revision": .int(rev)]))
                }
                return (200, .object(["results": .array(results)]))
            case ("DELETE", "/v1/auth/session"):
                return (204, .null)
            default:
                let parts = p.split(separator: "/").map(String.init) // v1 sync keyrings K [wraps D] | v1 sync objects C O
                if parts.count == 5, parts[2] == "objects" {
                    guard let o = objects.first(where: { $0.collection == parts[3] && $0.objectId == parts[4] }) else { return notFound }
                    return (200, wire(o))
                }
                if parts.count >= 4, parts[2] == "keyrings", let k = UInt32(parts[3]), let ring = keyrings[k] {
                    if method == "GET" {
                        return (200, .object(["keyId": .int(Int64(k)), "recoveryWrap": .string(ring.recovery),
                                              "wrap": bound.flatMap { ring.wraps[$0] }.map { .string($0) } ?? .null]))
                    }
                    if method == "PUT", parts.count == 6 {
                        if ring.wraps[parts[5]] != nil { return (409, .object(["error": .string("wrap-exists")])) }
                        keyrings[k]!.wraps[parts[5]] = b.str("wrap")
                        return (204, .null)
                    }
                }
                return notFound
            }
        }

        func me() -> JSONValue {
            .object(["id": .string(account), "email": .string("ada@example.com"), "plan": .string(plan), "canSync": .bool(plan != "free")])
        }
    }

    /// The computer that turned sync on, played by the test the way `crates/nekko-cloud` does it.
    struct Computer {
        let id = "dev-mac"
        let key = SyncCrypto.SoftwareKey()
        var keyring = SyncCrypto.Keyring.generate()
        var epoch: UInt32 = 1
        let recovery = SyncCrypto.RecoveryKey.generate()
        var recoveryPublic: Data { SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963 }
        var publicKey: String { SyncCrypto.base64url(key.publicKeyX963) }
    }

    /// A computer that turned sync on: keyring, recovery key, the epoch's account record and two chats.
    func computer(_ fake: FakeCloud) throws -> Computer {
        let mac = Computer()
        fake.devices.append((mac.id, mac.publicKey, "Studio Mac", nil))
        let selfWrap = try SyncCrypto.wrapKeyring(mac.keyring, account: fake.account, keyId: 1, recipientId: mac.id,
                                                  recipientPublic: mac.key.publicKeyX963, senderId: mac.id, sender: mac.key)
        fake.keyrings[1] = (try SyncCrypto.sealRecovery(recoveryPublic: mac.recoveryPublic, keyring: mac.keyring, account: fake.account, keyId: 1),
                            [mac.id: selfWrap])
        try writeRecord(fake, mac, devices: [(mac.id, mac.publicKey)])
        try sealChat(fake, mac, id: "s_1", title: "Plan the Kyoto trip", text: "Book the ryokan", updated: 10, rev: 1)
        try sealChat(fake, mac, id: "s_2", title: "Fix the flaky test", text: "It's a race", updated: 20, rev: 1)
        return mac
    }

    /// Write the computer's epoch's account record listing `devices`, one revision past what the server has.
    func writeRecord(_ fake: FakeCloud, _ mac: Computer, devices: [(String, String)], recoveryPublic: Data? = nil) throws {
        let list = devices.map { #"{"id":"\#($0.0)","publicKey":"\#($0.1)","label":""}"# }.joined(separator: ",")
        let rp = SyncCrypto.base64url(recoveryPublic ?? mac.recoveryPublic)
        let record = #"{"v":2,"epoch":\#(mac.epoch),"recoveryPublic":"\#(rp)","devices":[\#(list)]}"#
        let oid = try SyncCrypto.objectId(keyring: mac.keyring, collection: "account", localId: "epoch-\(mac.epoch)")
        let rev = (fake.objects.first { $0.objectId == oid }?.revision ?? 0) + 1
        fake.add("account", oid, rev, mac.epoch, try SyncCrypto.sealRecord(keyring: mac.keyring, account: fake.account, keyId: mac.epoch,
                                                                            collection: "account", objectId: oid, revision: UInt64(rev),
                                                                            plaintext: Data(record.utf8)))
    }

    func sealChat(_ fake: FakeCloud, _ mac: Computer, id: String, title: String, text: String, updated: Double, rev: Int64, oid: String? = nil,
                  keyring: SyncCrypto.Keyring? = nil, epoch: UInt32? = nil) throws {
        let chat = #"{"v":1,"chat":{"id":"\#(id)","title":"\#(title)","updatedAt":\#(updated),"messages":[{"role":"user","content":"\#(text)"}]}}"#
        let k = keyring ?? mac.keyring
        let o = try oid ?? SyncCrypto.objectId(keyring: k, collection: "chat", localId: id)
        fake.add("chat", o, rev, epoch ?? mac.epoch, try SyncCrypto.sealRecord(keyring: k, account: fake.account, keyId: epoch ?? mac.epoch,
                                                                                collection: "chat", objectId: o, revision: UInt64(rev),
                                                                                plaintext: Data(chat.utf8)))
    }

    func phone(_ fake: FakeCloud, key: SyncCrypto.SoftwareKey = SyncCrypto.SoftwareKey(), secrets: MemorySecrets = MemorySecrets()) -> CloudSync {
        CloudSync(api: URL(string: "https://api.example")!, http: fake, secrets: secrets, files: nil, deviceLabel: "iPhone", key: { key })
    }

    func text(_ p: CloudSync, _ id: String) -> String? { p.chats.first { $0.id == id }?.messages.first?.text }

    func testSignInThenRestoreWithTheRecoveryKeyReadsTheChats() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        XCTAssertEqual(p.phase, .signedOut)
        try await p.sendCode(email: "ada@example.com")
        do { try await p.verifyCode(email: "ada@example.com", code: "000000"); XCTFail("a wrong code signs in") } catch {}
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        XCTAssertEqual(p.phase, .needsJoin)
        do { try await p.restore(recoveryKey: SyncCrypto.RecoveryKey.generate().text); XCTFail("another account's key opens it") } catch {}
        try await p.restore(recoveryKey: mac.recovery.text.lowercased())
        XCTAssertEqual(p.phase, .idle)
        XCTAssertEqual(p.chats.map(\.title), ["Fix the flaky test", "Plan the Kyoto trip"])
        XCTAssertEqual(p.chats.last?.messages.first?.text, "Book the ryokan")
        // The phone added itself to the sealed device list, keeping the computer.
        XCTAssertTrue(p.devices.first { $0.thisDevice }?.trusted == true)
        XCTAssertTrue(p.devices.first { $0.id == mac.id }?.trusted == true)
    }

    func testRestoreRefusesToInventAMissingAccountRecord() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        fake.objects.removeAll { $0.collection == "account" }
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        do { try await p.restore(recoveryKey: mac.recovery.text); XCTFail("restored without the account's record") } catch {}
        XCTAssertNotEqual(p.phase, .idle)
        XCTAssertFalse(fake.objects.contains { $0.collection == "account" }, "no record listing only the phone was pushed")
    }

    func testJoiningByApprovalWithTheJoinCode() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let key = SyncCrypto.SoftwareKey()
        let p = phone(fake, key: key)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.requestJoin()
        XCTAssertEqual(p.phase, .awaitingApproval)
        let shown = try XCTUnwrap(p.joinCode)
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice })
        XCTAssertTrue(me.askedToJoin)
        try await p.sync()
        XCTAssertEqual(p.phase, .awaitingApproval, "nothing to open until approved")

        // The server (or anyone signed in) hands the phone a keyring without the code: refused.
        let fakeRing = SyncCrypto.Keyring.generate()
        fake.keyrings[1]!.wraps[me.id] = try SyncCrypto.wrapKeyring(fakeRing, account: fake.account, keyId: 1, recipientId: me.id,
                                                                    recipientPublic: key.publicKeyX963, senderId: mac.id, sender: SyncCrypto.SoftwareKey())
        try await p.sync()
        XCTAssertEqual(p.phase, .awaitingApproval)
        fake.keyrings[1]!.wraps[me.id] = nil

        // The computer checks the tag with the typed code, lists the phone, and wraps with the code.
        let code = try SyncCrypto.JoinCode(text: shown)
        let tag = try SyncCrypto.fromBase64url(try XCTUnwrap(fake.devices.first { $0.id == me.id }?.joinTag))
        XCTAssertTrue(code.verifies(account: fake.account, publicKey: key.publicKeyX963, tag: tag))
        try writeRecord(fake, mac, devices: [(mac.id, mac.publicKey), (me.id, SyncCrypto.base64url(key.publicKeyX963))])
        fake.keyrings[1]!.wraps[me.id] = try SyncCrypto.wrapForJoin(mac.keyring, account: fake.account, keyId: 1, recipientId: me.id,
                                                                    recipientPublic: key.publicKeyX963, code: code)
        try await p.sync()
        XCTAssertEqual(p.phase, .idle)
        XCTAssertEqual(p.chats.count, 2)
        XCTAssertNil(p.joinCode, "the code is forgotten once used")
    }

    func testApprovingAComputerChecksItsCode() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        // A new computer asks to join with a code.
        let laptop = SyncCrypto.SoftwareKey()
        let code = SyncCrypto.JoinCode.generate()
        fake.devices.append(("dev-laptop", SyncCrypto.base64url(laptop.publicKeyX963), "MacBook", SyncCrypto.base64url(code.tag(account: fake.account, publicKey: laptop.publicKeyX963))))
        do { try await p.approve(deviceId: "dev-laptop", code: SyncCrypto.JoinCode.generate().text); XCTFail("a wrong code approved it") } catch {}
        XCTAssertNil(fake.keyrings[1]!.wraps["dev-laptop"])
        // The server swaps in its own key: the right code no longer matches.
        let real = fake.devices[fake.devices.count - 1]
        fake.devices[fake.devices.count - 1].publicKey = SyncCrypto.base64url(SyncCrypto.SoftwareKey().publicKeyX963)
        do { try await p.approve(deviceId: "dev-laptop", code: code.text); XCTFail("approved a swapped key") } catch {}
        XCTAssertNil(fake.keyrings[1]!.wraps["dev-laptop"])
        fake.devices[fake.devices.count - 1] = real
        try await p.approve(deviceId: "dev-laptop", code: code.text.lowercased())
        let wrap = try XCTUnwrap(fake.keyrings[1]!.wraps["dev-laptop"])
        XCTAssertEqual(try SyncCrypto.unwrapJoin(key: laptop, account: fake.account, keyId: 1, deviceId: "dev-laptop", code: code, wrap: wrap), mac.keyring)
        XCTAssertTrue(p.devices.first { $0.id == "dev-laptop" }?.trusted == true)
    }

    func testANewEpochIsTakenOnlyFromATrustedDevice() async throws {
        let fake = FakeCloud()
        var mac = try computer(fake)
        let key = SyncCrypto.SoftwareKey()
        let p = phone(fake, key: key)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice }).id
        let phonePub = SyncCrypto.base64url(key.publicKeyX963)

        // Someone else announces epoch 2 with a keyring wrapped "from the Mac" with their own key: refused.
        let forged = SyncCrypto.Keyring.generate()
        fake.keyrings[2] = ("", [me: try SyncCrypto.wrapKeyring(forged, account: fake.account, keyId: 2, recipientId: me, recipientPublic: key.publicKeyX963,
                                                               senderId: mac.id, sender: SyncCrypto.SoftwareKey())])
        do { try await p.sync(); XCTFail("took a keyring from an untrusted key") } catch {}
        fake.keyrings[2] = nil

        // The Mac rotates for real: epoch 2, wrapped by the Mac, record listing both, chats sealed again.
        let old = mac.keyring
        mac.keyring = mac.keyring.rotated()
        mac.epoch = 2
        fake.keyrings[2] = (try SyncCrypto.sealRecovery(recoveryPublic: mac.recoveryPublic, keyring: mac.keyring, account: fake.account, keyId: 2),
                            [me: try SyncCrypto.wrapKeyring(mac.keyring, account: fake.account, keyId: 2, recipientId: me, recipientPublic: key.publicKeyX963,
                                                            senderId: mac.id, sender: mac.key)])
        try writeRecord(fake, mac, devices: [(mac.id, mac.publicKey), (me, phonePub)])
        try sealChat(fake, mac, id: "s_1", title: "Plan the Kyoto trip", text: "After the rotation", updated: 40, rev: 2)
        try await p.sync()
        XCTAssertEqual(text(p, "s_1"), "After the rotation")

        // A revoked device with the old keyring writes under epoch 1: ignored.
        try sealChat(fake, mac, id: "s_1", title: "Plan the Kyoto trip", text: "Forged under epoch 1", updated: 99, rev: 3, keyring: old, epoch: 1)
        try await p.sync()
        XCTAssertEqual(text(p, "s_1"), "After the rotation")
    }

    func testTamperedSwappedAndRolledBackRecordsAreIgnored() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        // A newer revision of s_1 lands; then the server replays the old one (rollback).
        try sealChat(fake, mac, id: "s_1", title: "Plan the Kyoto trip", text: "Changed plans", updated: 30, rev: 2)
        try await p.sync()
        XCTAssertEqual(text(p, "s_1"), "Changed plans")
        try sealChat(fake, mac, id: "s_1", title: "Plan the Kyoto trip", text: "Book the ryokan", updated: 10, rev: 1)
        try await p.sync()
        XCTAssertEqual(text(p, "s_1"), "Changed plans", "a replayed old revision is ignored")
        // A chat filed under another chat's id (the server swapping records) is refused.
        let s2 = try SyncCrypto.objectId(keyring: mac.keyring, collection: "chat", localId: "s_2")
        try sealChat(fake, mac, id: "s_9", title: "Planted", text: "x", updated: 99, rev: 2, oid: s2)
        // A flipped bit doesn't open.
        let o = try SyncCrypto.objectId(keyring: mac.keyring, collection: "chat", localId: "s_3")
        var raw = try SyncCrypto.fromBase64url(try SyncCrypto.sealRecord(keyring: mac.keyring, account: fake.account, keyId: 1, collection: "chat", objectId: o, revision: 1,
                                                                      plaintext: Data(#"{"v":1,"chat":{"id":"s_3","title":"T","updatedAt":1,"messages":[]}}"#.utf8)))
        raw[40] ^= 1
        fake.add("chat", o, 1, 1, SyncCrypto.base64url(raw))
        try await p.sync()
        XCTAssertEqual(Set(p.chats.map(\.id)), ["s_1", "s_2"])
        // An account record naming another recovery key is refused.
        try writeRecord(fake, mac, devices: [], recoveryPublic: SyncCrypto.recoveryAgreementKey(SyncCrypto.RecoveryKey.generate()).publicKeyX963)
        try await p.sync()
        XCTAssertTrue(p.devices.first { $0.thisDevice }?.trusted == true, "the swapped record was ignored")
    }

    func testAnotherAccountNeverSeesTheFirstAccountsKeysOrChats() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let secrets = MemorySecrets()
        let p = phone(fake, secrets: secrets)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        XCTAssertEqual(p.chats.count, 2)
        await p.signOut()
        fake.account = "acct-2"
        fake.keyrings = [:]
        fake.objects = []
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        XCTAssertEqual(p.chats, [])
        XCTAssertNil(secrets.items["cloud.keyring.1"])
        XCTAssertEqual(p.phase, .notSetUp)
    }

    func testOutOfRangeNumbersFromTheServerDontCrash() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let bads: [JSONValue] = [.int(-1), .int(0), .int(Int64(UInt32.max) + 1)]
        // Revisions and key epochs in pulled objects: ignored, the chats stay.
        for bad in bads {
            fake.rewrite = { _, path, body in
                if path == "/v1/sync/pull", case .object(var o) = body {
                    o["objects"] = .array([.object(["collection": .string("chat"), "objectId": .string(String(repeating: "A", count: 43)),
                                                    "revision": bad, "keyId": bad, "blob": .string("AA"), "seq": .int(1)])])
                    body = .object(o)
                }
            }
            _ = try? await p.sync()
        }
        XCTAssertEqual(p.chats.count, 2)
        // The current epoch: whatever it is, no trap (a missing one reads as "everything was deleted").
        for bad in bads {
            fake.rewrite = { _, path, body in
                if path == "/v1/sync/state", case .object(var o) = body { o["currentKeyId"] = bad; body = .object(o) }
            }
            _ = try? await p.sync()
            _ = try? await p.refresh()
        }
        fake.rewrite = nil
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
