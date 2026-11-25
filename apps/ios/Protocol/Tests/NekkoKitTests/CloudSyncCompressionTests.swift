import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// The iPhone's side of compressed records (decision 0121): the account record keeps device
/// capabilities, the phone advertises that it reads them, and a phone that predates them pulls once
/// from the start when the account has used them.
extension CloudSyncTests {
    func testAccountRecordKeepsCapsAndTheCompressedMark() throws {
        let json = #"{"v":2,"epoch":3,"recoveryPublic":"rp","compressed":true,"devices":[{"id":"a","publicKey":"pk","label":"Mac","caps":["z1","future"]},{"id":"b","publicKey":"pk2","label":""}]}"#
        let r = try XCTUnwrap(CloudSync.accountRecord(json))
        XCTAssertTrue(r.compressed)
        XCTAssertEqual(r.devices[0].caps, ["z1", "future"])
        XCTAssertEqual(r.devices[1].caps, [])
        let back = try XCTUnwrap(CloudSync.accountRecord(CloudSync.accountRecordJSON(r)))
        XCTAssertEqual(back, r)
        // An older record, with neither, still reads, and writes neither.
        let old = try XCTUnwrap(CloudSync.accountRecord(#"{"v":2,"epoch":1,"recoveryPublic":"rp","devices":[{"id":"a","publicKey":"pk","label":""}]}"#))
        XCTAssertFalse(old.compressed)
        XCTAssertFalse(CloudSync.accountRecordJSON(old).contains("caps"))
        XCTAssertFalse(CloudSync.accountRecordJSON(old).contains("compressed"))
    }

    /// The server's newest account record for the computer's epoch, opened.
    func serverRecord(_ fake: FakeCloud, _ mac: Computer) throws -> CloudSync.AccountRecord {
        let oid = try SyncCrypto.objectId(keyring: mac.keyring, collection: "account", localId: "epoch-\(mac.epoch)")
        let o = try XCTUnwrap(fake.objects.first { $0.objectId == oid })
        let plain = try SyncCrypto.openRecord(keyring: mac.keyring, account: fake.account, keyId: mac.epoch, collection: "account",
                                              objectId: oid, revision: UInt64(o.revision), blob: o.blob)
        return try XCTUnwrap(CloudSync.accountRecord(plain))
    }

    func writeRecord(_ fake: FakeCloud, _ mac: Computer, devices: [(String, String)], compressed: Bool) throws {
        let list = devices.map { #"{"id":"\#($0.0)","publicKey":"\#($0.1)","label":"","caps":["z1"]}"# }.joined(separator: ",")
        let record = #"{"v":2,"epoch":\#(mac.epoch),"recoveryPublic":"\#(SyncCrypto.base64url(mac.recoveryPublic))","compressed":\#(compressed),"devices":[\#(list)]}"#
        let oid = try SyncCrypto.objectId(keyring: mac.keyring, collection: "account", localId: "epoch-\(mac.epoch)")
        let rev = (fake.objects.first { $0.objectId == oid }?.revision ?? 0) + 1
        fake.add("account", oid, rev, mac.epoch, try SyncCrypto.sealRecord(keyring: mac.keyring, account: fake.account, keyId: mac.epoch, collection: "account",
                                                                            objectId: oid, revision: UInt64(rev), plaintext: Data(record.utf8)))
    }

    func testAPhoneApprovedByAnOlderBuildAdvertisesOnItsNextSync() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let key = SyncCrypto.SoftwareKey()
        let p = phone(fake, key: key)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.requestJoin()
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice })
        let code = try SyncCrypto.JoinCode(text: try XCTUnwrap(p.joinCode))
        // Listed without caps, the way an older build lists a device; the computer also lists nothing for itself.
        try writeRecord(fake, mac, devices: [(mac.id, mac.publicKey), (me.id, SyncCrypto.base64url(key.publicKeyX963))], compressed: false)
        let list = #"{"id":"\#(mac.id)","publicKey":"\#(mac.publicKey)","label":""},{"id":"\#(me.id)","publicKey":"\#(SyncCrypto.base64url(key.publicKeyX963))","label":""}"#
        let oid = try SyncCrypto.objectId(keyring: mac.keyring, collection: "account", localId: "epoch-1")
        let rev = (fake.objects.first { $0.objectId == oid }?.revision ?? 0) + 1
        let bare = #"{"v":2,"epoch":1,"recoveryPublic":"\#(SyncCrypto.base64url(mac.recoveryPublic))","devices":[\#(list)]}"#
        fake.add("account", oid, rev, 1, try SyncCrypto.sealRecord(keyring: mac.keyring, account: fake.account, keyId: 1, collection: "account",
                                                                    objectId: oid, revision: UInt64(rev), plaintext: Data(bare.utf8)))
        fake.keyrings[1]!.wraps[me.id] = try SyncCrypto.wrapForJoin(mac.keyring, account: fake.account, keyId: 1, recipientId: me.id,
                                                                    recipientPublic: key.publicKeyX963, code: code)
        try await p.sync()
        let after = try serverRecord(fake, mac)
        XCTAssertEqual(after.devices.first { $0.id == me.id }?.caps, ["z1"])
        XCTAssertEqual(after.devices.first { $0.id == mac.id }?.caps, [], "only its own entry changes")
        XCTAssertEqual(after.devices.count, 2)
        // Once is enough: another sync writes nothing.
        let seqBefore = fake.seq
        try await p.sync()
        XCTAssertEqual(fake.seq, seqBefore)
    }

    func testAPhoneThatPredatesCompressionPullsAgainOnlyWhenTheAccountUsedIt() async throws {
        for compressed in [false, true] {
            let fake = FakeCloud()
            let mac = try computer(fake)
            let secrets = MemorySecrets()
            let key = SyncCrypto.SoftwareKey()
            let p = phone(fake, key: key, secrets: secrets)
            try await p.verifyCode(email: "ada@example.com", code: "123456")
            try await p.restore(recoveryKey: mac.recovery.text)
            XCTAssertEqual(p.chats.count, 2)
            let me = try XCTUnwrap(p.devices.first { $0.thisDevice })
            // A deflated chat that an older build skipped: it sits behind the phone's cursor.
            let chat = #"{"v":1,"chat":{"id":"s_3","title":"Compressed","updatedAt":30,"messages":[{"role":"user","content":"\#(String(repeating: "long line of tool output ", count: 80))"}]}}"#
            let oid = try SyncCrypto.objectId(keyring: mac.keyring, collection: "chat", localId: "s_3")
            fake.add("chat", oid, 1, 1, try SyncCrypto.sealRecordCompressed(keyring: mac.keyring, account: fake.account, keyId: 1, collection: "chat",
                                                                            objectId: oid, revision: 1, plaintext: Data(chat.utf8)))
            try writeRecord(fake, mac, devices: [(mac.id, mac.publicKey), (me.id, SyncCrypto.base64url(key.publicKeyX963))], compressed: compressed)
            // The state an older build saved: past everything, no mark of compression support.
            var state = try XCTUnwrap(try JSONValue.parse(Data(try XCTUnwrap(secrets.get("cloud.state")).utf8)).object)
            state["cursor"] = .int(fake.seq)
            state["zReady"] = nil
            state["zCatchup"] = nil
            secrets.set("cloud.state", JSONValue.object(state).serialized())
            let upgraded = phone(fake, key: key, secrets: secrets)
            // (No offline files here, so the phone starts with no chats, and the two it already read are
            // not applied again: a pull from the start finds only the one it skipped.)
            try await upgraded.sync()
            XCTAssertEqual(upgraded.chats.map(\.title), compressed ? ["Compressed"] : [], "compressed \(compressed)")
            // The catch-up happens once: the mark is spent either way.
            let saved = try JSONValue.parse(Data(try XCTUnwrap(secrets.get("cloud.state")).utf8))
            XCTAssertEqual(saved["zCatchup"]?.bool, false)
            XCTAssertEqual(saved["zReady"]?.bool, true)
        }
    }
}
