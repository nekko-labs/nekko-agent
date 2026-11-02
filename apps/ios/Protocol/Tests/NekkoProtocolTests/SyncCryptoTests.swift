import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import NekkoProtocol

/// The iPhone's sync crypto against the vectors `crates/nekko-sync` is tested
/// with (`Fixtures/sync-crypto.json`, a copy that the Rust test checks is current).
final class SyncCryptoTests: XCTestCase {
    func vector() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "sync-crypto", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func d(_ v: JSONValue?, _ key: String) throws -> Data {
        try SyncCrypto.fromBase64url(try XCTUnwrap(v?.str(key), key))
    }

    func testObjectIdsAndRecordsAreByteIdentical() throws {
        let v = try vector()
        let account = try XCTUnwrap(v.str("account"))
        let keyring = try SyncCrypto.Keyring(bytes: try d(v, "keyring"))
        for o in try XCTUnwrap(v["objectIds"]?.array) {
            XCTAssertEqual(try SyncCrypto.objectId(keyring: keyring, collection: try XCTUnwrap(o.str("collection")),
                                                   localId: try XCTUnwrap(o.str("localId"))), o.str("objectId"))
        }
        for r in try XCTUnwrap(v["records"]?.array) + [try XCTUnwrap(v["longRecord"])] {
            let (c, o) = (try XCTUnwrap(r.str("collection")), try XCTUnwrap(r.str("objectId")))
            let (rev, kid) = (UInt64(try XCTUnwrap(r.long("revision"))), UInt32(try XCTUnwrap(r.long("keyId"))))
            let text = try XCTUnwrap(r.str("plaintext"))
            let sealed = try SyncCrypto.sealRecord(keyring: keyring, account: account, keyId: kid, collection: c, objectId: o,
                                                   revision: rev, plaintext: Data(text.utf8), salt: try d(r, "salt"))
            XCTAssertEqual(sealed, r.str("blob"))
            let opened = try SyncCrypto.openRecord(keyring: keyring, account: account, keyId: kid, collection: c, objectId: o,
                                                   revision: rev, blob: try XCTUnwrap(r.str("blob")))
            XCTAssertEqual(String(decoding: opened, as: UTF8.self), text)
            // Relabelled by the server: another revision or object.
            XCTAssertThrowsError(try SyncCrypto.openRecord(keyring: keyring, account: account, keyId: kid, collection: c, objectId: o,
                                                           revision: rev + 1, blob: sealed))
            XCTAssertThrowsError(try SyncCrypto.openRecord(keyring: keyring, account: "someone-else", keyId: kid, collection: c,
                                                           objectId: o, revision: rev, blob: sealed))
        }
    }

    func testEpochProofsMatch() throws {
        let v = try vector()
        let keyring = try SyncCrypto.Keyring(bytes: try d(v, "keyring"))
        let proofs = try XCTUnwrap(v["epochProofs"]?.array)
        XCTAssertFalse(proofs.isEmpty)
        for p in proofs {
            let keyId = UInt32(try XCTUnwrap(p.long("keyId")))
            XCTAssertEqual(SyncCrypto.epochProof(keyring: keyring, keyId: keyId), try d(p, "proof"))
        }
        XCTAssertNotEqual(SyncCrypto.epochProof(keyring: keyring, keyId: 1), SyncCrypto.epochProof(keyring: keyring.rotated(), keyId: 1))
    }

    func testPadmeMatches() throws {
        for p in try XCTUnwrap(try vector()["padme"]?.array) {
            let pair = try XCTUnwrap(p.array)
            XCTAssertEqual(SyncCrypto.padme(Int(try XCTUnwrap(pair[0].int64))), Int(try XCTUnwrap(pair[1].int64)))
        }
        XCTAssertEqual(SyncCrypto.frame(Data()).count, 256)
        XCTAssertEqual(try SyncCrypto.unframe(SyncCrypto.frame(Data("hi".utf8))), Data("hi".utf8))
    }

    func testWrapRecoveryAndDonationMatch() throws {
        let v = try vector()
        let account = try XCTUnwrap(v.str("account"))
        let keyring = try SyncCrypto.Keyring(bytes: try d(v, "keyring"))
        let device = try SyncCrypto.SoftwareKey(rawRepresentation: try d(v["device"], "private"))
        let eph = try SyncCrypto.SoftwareKey(rawRepresentation: try d(v["ephemeral"], "private"))
        let deviceId = try XCTUnwrap(v["device"]?.str("id"))
        XCTAssertEqual(SyncCrypto.base64url(device.publicKeyX963), v["device"]?.str("public"))
        XCTAssertEqual(SyncCrypto.fingerprint(publicKey: device.publicKeyX963), v["device"]?.str("fingerprint"))

        let sender = try SyncCrypto.SoftwareKey(rawRepresentation: try d(v["sender"], "private"))
        let senderId = try XCTUnwrap(v["sender"]?.str("id"))
        XCTAssertEqual(SyncCrypto.base64url(sender.publicKeyX963), v["sender"]?.str("public"))
        let wrap = try SyncCrypto.wrapKeyring(keyring, account: account, keyId: 1, recipientId: deviceId, recipientPublic: device.publicKeyX963,
                                              senderId: senderId, sender: sender, ephemeral: eph)
        XCTAssertEqual(wrap, v["wrap"]?.str("blob"))
        let open = { (key: SyncAgreementKey, device: String, from: String, fromKey: Data) in
            try SyncCrypto.unwrapKeyring(key: key, account: account, keyId: 1, deviceId: device, senderId: from, senderPublic: fromKey, wrap: wrap)
        }
        XCTAssertEqual(try open(device, deviceId, senderId, sender.publicKeyX963), keyring)
        XCTAssertThrowsError(try open(device, "another", senderId, sender.publicKeyX963))
        XCTAssertThrowsError(try open(SyncCrypto.SoftwareKey(), deviceId, senderId, sender.publicKeyX963))
        // Only as coming from the device that made it: anyone else's key, or another sender id, fails.
        XCTAssertThrowsError(try open(device, deviceId, senderId, SyncCrypto.SoftwareKey().publicKeyX963))
        XCTAssertThrowsError(try open(device, deviceId, "dev_other", sender.publicKeyX963))

        // Join codes: the same tag and wrap as the computer makes.
        let join = try XCTUnwrap(v["join"])
        let code = try SyncCrypto.JoinCode(text: try XCTUnwrap(join.str("code")).lowercased())
        XCTAssertEqual(code, try SyncCrypto.JoinCode(bytes: Data(SHA256Seed.bytes("join-code").prefix(10))))
        XCTAssertEqual(code.text, join.str("code"))
        let tag = try d(join, "tag")
        XCTAssertEqual(code.tag(account: account, publicKey: device.publicKeyX963), tag)
        XCTAssertTrue(code.verifies(account: account, publicKey: device.publicKeyX963, tag: tag))
        XCTAssertFalse(code.verifies(account: account, publicKey: sender.publicKeyX963, tag: tag), "a swapped key fails")
        let joinWrap = try SyncCrypto.wrapForJoin(keyring, account: account, keyId: 3, recipientId: deviceId,
                                                  recipientPublic: device.publicKeyX963, code: code, ephemeral: eph)
        XCTAssertEqual(joinWrap, join.str("blob"))
        XCTAssertEqual(try SyncCrypto.unwrapJoin(key: device, account: account, keyId: 3, deviceId: deviceId, code: code, wrap: joinWrap), keyring)
        XCTAssertThrowsError(try SyncCrypto.unwrapJoin(key: device, account: account, keyId: 3, deviceId: deviceId,
                                                       code: SyncCrypto.JoinCode.generate(), wrap: joinWrap))

        let recovery = try SyncCrypto.RecoveryKey(bytes: try d(v["recovery"], "key"))
        XCTAssertEqual(recovery.text, v["recovery"]?.str("text"))
        let typed = try XCTUnwrap(v["recovery"]?.str("text")).lowercased().replacingOccurrences(of: "-", with: " ")
        XCTAssertEqual(try SyncCrypto.RecoveryKey(text: typed), recovery)
        let recoveryPublic = SyncCrypto.recoveryAgreementKey(recovery).publicKeyX963
        XCTAssertEqual(SyncCrypto.base64url(recoveryPublic), v["recovery"]?.str("public"))
        let rblob = try SyncCrypto.sealRecovery(recoveryPublic: recoveryPublic, keyring: keyring, account: account, keyId: 1, ephemeral: eph)
        XCTAssertEqual(rblob, v["recovery"]?.str("blob"))
        XCTAssertEqual(try SyncCrypto.openRecovery(recovery, account: account, keyId: 1, blob: rblob), keyring)
        XCTAssertThrowsError(try SyncCrypto.openRecovery(recovery, account: account, keyId: 2, blob: rblob))

        let dv = try XCTUnwrap(v["donation"])
        let research = try SyncCrypto.SoftwareKey(rawRepresentation: try d(dv, "researchPrivate"))
        let donation = try SyncCrypto.sealDonation(researchPublic: research.publicKeyX963, payload: Data(try XCTUnwrap(dv.str("payload")).utf8),
                                                   id: Data(SHA256Seed.bytes("donation-id").prefix(16)),
                                                   deleteToken: SHA256Seed.bytes("delete-token"), ephemeral: eph)
        XCTAssertEqual(donation, SyncCrypto.Donation(id: try XCTUnwrap(dv.str("id")), blob: try XCTUnwrap(dv.str("blob")),
                                                     deleteToken: try XCTUnwrap(dv.str("deleteToken")), deleteHash: try XCTUnwrap(dv.str("deleteHash"))))
        let framed = try SyncCrypto.openSealed(key: research, context: "nekko-donation/v1\n\(donation.id)", blob: donation.blob)
        XCTAssertEqual(String(decoding: try SyncCrypto.unframe(framed), as: UTF8.self), dv.str("payload"))
    }

    func testRecoveryKeysCatchTyposAndRoundTrip() throws {
        let key = SyncCrypto.RecoveryKey.generate()
        XCTAssertEqual(key.text.count, 65)
        XCTAssertEqual(try SyncCrypto.RecoveryKey(text: key.text), key)
        var chars = Array(key.text)
        chars[3] = chars[3] == "A" ? "B" : "A"
        XCTAssertThrowsError(try SyncCrypto.RecoveryKey(text: String(chars)))
        XCTAssertThrowsError(try SyncCrypto.RecoveryKey(text: String(key.text.dropLast())))
        XCTAssertThrowsError(try SyncCrypto.RecoveryKey(text: key.text + "0"))
        // ASCII only, as on the computer: no Unicode case mapping ("ß" would become "SS").
        XCTAssertThrowsError(try SyncCrypto.RecoveryKey(text: key.text.replacingOccurrences(of: "-", with: "ß")))
        let code = SyncCrypto.JoinCode.generate()
        XCTAssertEqual(code.text.count, 19)
        XCTAssertEqual(try SyncCrypto.JoinCode(text: code.text.lowercased().replacingOccurrences(of: "-", with: " ")), code)
        XCTAssertThrowsError(try SyncCrypto.JoinCode(text: String(code.text.dropLast())))
    }

    func testEveryFlippedBitIsCaughtAndSealsNeverRepeat() throws {
        let keyring = SyncCrypto.Keyring.generate()
        let oid = try SyncCrypto.objectId(keyring: keyring, collection: "chat", localId: "s_1")
        XCTAssertEqual(oid, try SyncCrypto.objectId(keyring: keyring.rotated(), collection: "chat", localId: "s_1"))
        let blob = try SyncCrypto.sealRecord(keyring: keyring, account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: Data("x".utf8))
        XCTAssertNotEqual(blob, try SyncCrypto.sealRecord(keyring: keyring, account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, plaintext: Data("x".utf8)))
        let raw = try SyncCrypto.fromBase64url(blob)
        for i in stride(from: 0, to: raw.count, by: 7) {
            var bad = raw
            bad[i] ^= 1
            XCTAssertThrowsError(try SyncCrypto.openRecord(keyring: keyring, account: "a", keyId: 1, collection: "chat", objectId: oid,
                                                           revision: 1, blob: SyncCrypto.base64url(bad)), "byte \(i)")
        }
        XCTAssertThrowsError(try SyncCrypto.openRecord(keyring: keyring.rotated(), account: "a", keyId: 1, collection: "chat", objectId: oid, revision: 1, blob: blob))
    }
}

/// The vectors' fixed inputs: the SHA-256 of a seed name (as in the Rust test).
enum SHA256Seed {
    static func bytes(_ name: String) -> Data {
        Data(SHA256.hash(data: Data(name.utf8)))
    }
}
