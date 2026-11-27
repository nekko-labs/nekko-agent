import Foundation
import XCTest
@testable import NekkoProtocol

/// The account HELLO proof (decisions 0102 and 0128), held to the bytes `crates/nekko-sync` seals and Android's
/// `FleetLinkTest` asserts, made by an independent Node implementation.
final class FleetLinkTests: XCTestCase {
    let acct = "a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    let dev = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    let other = "8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b"
    let ring = try! SyncCrypto.Keyring(bytes: Data((0..<64).map { UInt8($0) }))
    let salt = Data((0..<32).map { UInt8(255 - $0) })

    let helloVector = "Af_-_fz7-vn49_b19PPy8fDv7u3s6-rp6Ofm5eTj4uHgEQi7QXCNzHo8WqWTbDmKTSL088myJiCOC9GdT_48iwYlsZwvrE0JHmhXPjm1s5YoaPbVg8lUFTep_Nn23n7Zk9ZOavmjJae9_9n43-TQgSzkkt5sfX71i2kp1ZHhEuY7HSscUosbPTFBLkW1ENmOeLUW5CbPRxXaxvJUWgjHajok5oiMWDqzlZMUWROzWD0PxczVIq3I35jWFPc-QW8UMh7dFzfvhwHm2p3m92SQA1XZC8hZD99CcDloPoiVJufH_sqqj8AJIFZxq0XMr0fiZRKmPoaKFCuQ6AY4KFiNInHRuPQYHM4PBetgNDnZoPYe7MEgTLiBW-8C4JGlYNw-4khm8NKkH7zTvzv1uQekTHQ"

    func testSealsByteForByteAsNekkoSyncDoes() throws {
        XCTAssertEqual(try FleetLink.sealHelloProof(keyring: ring, accountId: acct, keyId: 4, deviceId: dev, plaintext: Data("proof".utf8), salt: salt),
                       helloVector)
        XCTAssertEqual(String(decoding: try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 4, deviceId: dev, blob: helloVector),
                              as: UTF8.self), "proof")
    }

    func testAProofOpensOnlyForItsAccountEpochDeviceAndKey() {
        func refused(_ f: () throws -> Data) { XCTAssertThrowsError(try f()) }
        refused { try FleetLink.openHelloProof(keyring: ring, accountId: other, keyId: 4, deviceId: dev, blob: helloVector) }
        refused { try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 5, deviceId: dev, blob: helloVector) }
        refused { try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 4, deviceId: other, blob: helloVector) }
        refused { try FleetLink.openHelloProof(keyring: SyncCrypto.Keyring.generate(), accountId: acct, keyId: 4, deviceId: dev, blob: helloVector) }
        refused { try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 4, deviceId: dev, blob: "not a blob") }
        refused { try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 4, deviceId: dev, blob: String(helloVector.dropLast(4))) }
    }

    func testIdsCannotSmuggleAssociatedDataSeparators() throws {
        XCTAssertThrowsError(try FleetLink.helloAAD(accountId: "a\nb", keyId: 1, deviceId: dev))
        XCTAssertThrowsError(try FleetLink.helloAAD(accountId: acct, keyId: 1, deviceId: "x\n1"))
        XCTAssertThrowsError(try FleetLink.helloAAD(accountId: "", keyId: 1, deviceId: dev))
        XCTAssertThrowsError(try FleetLink.helloAAD(accountId: acct, keyId: 0, deviceId: dev))
        XCTAssertEqual(try FleetLink.helloAAD(accountId: acct, keyId: 2, deviceId: dev), "nekko-sync/v1 fleet-hello\n\(acct)\n2\n\(dev)")
    }

    func testTheHelloCarriesTheBindingSealedForTheCurrentEpoch() throws {
        let b = FleetLink.Binding(room: "rm", challenge: "ch", hostEph: "he", clientEph: "ce", helloKey: "hk")
        let hello = try XCTUnwrap(FleetLink.hello(keyring: ring, accountId: acct, keyId: 3, deviceId: dev, binding: b))
        XCTAssertEqual(Set(hello.object!.keys), ["v", "accountId", "keyId", "deviceId", "proof"])
        XCTAssertEqual(hello.long("v"), 1)
        XCTAssertEqual(hello.str("accountId"), acct)
        XCTAssertEqual(hello.long("keyId"), 3)
        XCTAssertEqual(hello.str("deviceId"), dev, "no fleet: prefix inside the object")
        let plain = try FleetLink.openHelloProof(keyring: ring, accountId: acct, keyId: 3, deviceId: dev, blob: try XCTUnwrap(hello.str("proof")))
        let v = try JSONValue.parse(plain)
        XCTAssertEqual(v.long("v"), 1)
        XCTAssertEqual(v.str("orgId"), "", "an account device has no organization")
        XCTAssertEqual([v.str("room"), v.str("challenge"), v.str("hostEph"), v.str("clientEph"), v.str("helloKey")], ["rm", "ch", "he", "ce", "hk"])
        XCTAssertEqual(FleetLink.linkDeviceId(dev), "fleet:\(dev)")
    }

    func testRefusalsReadInPlainWordsAndOnlyStaleOnesRetry() {
        for r in [DenyReason.fleetOff, .fleetDevice, .fleetEpoch, .fleetAccount, .fleetLocked] {
            let text = FleetLink.refusalText(r, computer: "Studio")
            XCTAssertTrue(text?.contains("Studio") == true, "\(r)")
            XCTAssertFalse(text?.contains("\u{2014}") ?? false)
        }
        XCTAssertNil(FleetLink.refusalText(.revoked, computer: "Studio"))
        XCTAssertEqual(DenyReason.parse("fleet-off"), .fleetOff)
        XCTAssertEqual(DenyReason.parse("fleet-epoch"), .fleetEpoch)
        XCTAssertTrue(FleetLink.retryable(.fleetDevice) && FleetLink.retryable(.fleetEpoch))
        XCTAssertFalse(FleetLink.retryable(.fleetOff) || FleetLink.retryable(.fleetLocked) || FleetLink.retryable(.fleetAccount))
    }
}

/// The HELLO a client sends for an account device, through the real handshake fixture.
extension RelayClientTests {
    func testAnAccountHelloCarriesFleetAndNeverPairAndIsStillSigned() async throws {
        let f = try handshakeFixture()
        let signer = SoftwareHelloSigner()
        let ring = SyncCrypto.Keyring.generate()
        let (c, r, relay) = try fixtureClient(f, challengeWait: 5, signer: signer, accountDevice: "dev-phone") { b in
            FleetLink.hello(keyring: ring, accountId: "acct-1", keyId: 2, deviceId: "dev-phone", binding: b)
        }
        c.connect()
        let opened = await waitOpen(relay)
        try offer(f, on: XCTUnwrap(opened))
        let deadline = Date().addingTimeInterval(2)
        while relay.sync({ relay.hellos.isEmpty }), Date() < deadline { await sleep(0.01) }
        let hello = try XCTUnwrap(relay.sync { relay.hellos.first })
        XCTAssertEqual(hello.str("deviceId"), "fleet:dev-phone")
        XCTAssertEqual(hello.str("platform"), f.device.str("platform"))
        XCTAssertNil(hello["pair"])
        let fleet = try XCTUnwrap(hello["fleet"])
        XCTAssertEqual(fleet.str("deviceId"), "dev-phone")
        // Signed with the HELLO key, over the link's own device id.
        let key = try XCTUnwrap(hello.str("helloKey"))
        XCTAssertEqual(Data(base64Encoded: key), try signer.publicKey())
        // The proof binds this handshake: its room, the challenge, both halves of the exchange and the HELLO key.
        let clientEph = try XCTUnwrap(relay.sync { relay.answers.first })
        let plain = try FleetLink.openHelloProof(keyring: ring, accountId: "acct-1", keyId: 2, deviceId: "dev-phone", blob: try XCTUnwrap(fleet.str("proof")))
        let bound = try JSONValue.parse(plain)
        XCTAssertEqual([bound.str("room"), bound.str("challenge"), bound.str("hostEph"), bound.str("clientEph"), bound.str("helloKey")],
                       [f.room, f.nonce, f.hostEph, clientEph, key])
        _ = r
        c.close()
    }

    func testALockedAccountSendsNoHello() async throws {
        let f = try handshakeFixture()
        let (c, _, relay) = try fixtureClient(f, challengeWait: 5, signer: SoftwareHelloSigner(), accountDevice: "dev-phone") { _ in nil }
        c.connect()
        let opened = await waitOpen(relay)
        try offer(f, on: XCTUnwrap(opened))
        await sleep(0.2)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 0)
        c.close()
    }
}
