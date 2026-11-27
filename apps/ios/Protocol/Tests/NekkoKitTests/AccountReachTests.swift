import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// `reach` records (decision 0128): a computer of the account publishes how to reach it, sealed under the account
/// keyring in the ordinary record envelope, and the iPhone reads them through `CloudSync`.
extension CloudSyncTests {
    func sealReach(_ fake: FakeCloud, _ mac: Computer, device: String = "dev-mac-account", name: String = "Studio Mac", routes: [String] = ["wss://relay.nekko.example", "ws://studio.tail1.ts.net:4400"],
                   room: String = "room-1", secret: String = "secret-1", hostKey: String = "hostkey-1", rev: Int64, tombstone: Bool = false,
                   oid: String? = nil, keyring: SyncCrypto.Keyring? = nil, epoch: UInt32? = nil) throws {
        let k = keyring ?? mac.keyring
        let e = epoch ?? mac.epoch
        let o = try oid ?? SyncCrypto.objectId(keyring: k, collection: "reach", localId: device)
        let plain: JSONValue = tombstone
            ? .object(["v": .int(1), "deleted": .bool(true), "deviceId": .string(device)])
            : .object(["v": .int(1), "deviceId": .string(device), "name": .string(name), "routes": .array(routes.map { .string($0) }),
                       "room": .string(room), "secret": .string(secret), "hostKey": .string(hostKey)])
        fake.add("reach", o, rev, e, try SyncCrypto.sealRecord(keyring: k, account: fake.account, keyId: e, collection: "reach", objectId: o,
                                                                revision: UInt64(rev), plaintext: Data(plain.serialized().utf8)))
    }

    func testReachRecordsAreReadKeptAndTombstoned() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        try sealReach(fake, mac, rev: 1)
        let secrets = MemorySecrets()
        let key = SyncCrypto.SoftwareKey()
        let p = phone(fake, key: key, secrets: secrets)
        var seen: [[CloudSync.ReachRecord]] = []
        p.onReachChange = { seen.append($0) }
        XCTAssertEqual(p.reach, [], "nothing before sign-in")
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let r = try XCTUnwrap(p.reach.first)
        XCTAssertEqual(p.reach.count, 1)
        XCTAssertEqual([r.deviceId, r.name, r.room, r.secret, r.hostKey], ["dev-mac-account", "Studio Mac", "room-1", "secret-1", "hostkey-1"])
        XCTAssertEqual(r.routes, ["wss://relay.nekko.example", "ws://studio.tail1.ts.net:4400"])
        XCTAssertFalse("\(r)".contains("secret-1"), "a record never prints its secret")
        XCTAssertEqual(seen.last?.count, 1)
        // Kept across a relaunch, in the secret store.
        XCTAssertEqual(phone(fake, key: key, secrets: secrets).reach, [r])
        // The computer turns it off: a tombstone takes it away.
        try sealReach(fake, mac, rev: 2, tombstone: true)
        try await p.sync()
        XCTAssertEqual(p.reach, [])
        XCTAssertEqual(seen.last, [])
        XCTAssertEqual(phone(fake, key: key, secrets: secrets).reach, [])
    }

    func testSigningOutOfNekkoCloudTakesTheReachRecordsAway() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        try sealReach(fake, mac, rev: 1)
        let secrets = MemorySecrets()
        let p = phone(fake, secrets: secrets)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        XCTAssertEqual(p.reach.count, 1)
        var told: [Int] = []
        p.onReachChange = { told.append($0.count) }
        await p.signOut()
        XCTAssertEqual(p.reach, [])
        XCTAssertEqual(told.last, 0)
        XCTAssertNil(secrets.get("cloud.reach"), "the room secret does not stay in the Keychain")
    }

    func testTamperedSwappedAndRolledBackReachRecordsAreIgnored() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let clock = Clock()
        p.now = { clock.date }
        try sealReach(fake, mac, rev: 1)
        clock.advance(60)
        try await p.sync()
        XCTAssertEqual(p.reach.count, 1)
        // A tombstone lands, then the server replays the old record (rollback): it stays gone.
        try sealReach(fake, mac, rev: 2, tombstone: true)
        clock.advance(60)
        try await p.sync()
        XCTAssertEqual(p.reach, [])
        try sealReach(fake, mac, rev: 1)
        clock.advance(60)
        try await p.sync()
        XCTAssertEqual(p.reach, [], "a replayed old revision is ignored")
        // A record filed under another computer's id (the server swapping records) is refused.
        let other = try SyncCrypto.objectId(keyring: mac.keyring, collection: "reach", localId: "dev-other")
        try sealReach(fake, mac, device: "dev-planted", rev: 1, oid: other)
        // A flipped bit doesn't open.
        let flipped = try SyncCrypto.objectId(keyring: mac.keyring, collection: "reach", localId: "dev-flipped")
        var raw = try SyncCrypto.fromBase64url(try SyncCrypto.sealRecord(
            keyring: mac.keyring, account: fake.account, keyId: 1, collection: "reach", objectId: flipped, revision: 1,
            plaintext: Data(#"{"v":1,"deviceId":"dev-flipped","name":"X","routes":["ws://x"],"room":"r","secret":"s","hostKey":"h"}"#.utf8)))
        raw[40] ^= 1
        fake.add("reach", flipped, 1, 1, SyncCrypto.base64url(raw))
        // A record under another key epoch than this iPhone holds is not read.
        try sealReach(fake, mac, device: "dev-future", rev: 1, keyring: mac.keyring.rotated(), epoch: 2)
        clock.advance(60)
        try? await p.sync()
        XCTAssertEqual(p.reach, [])
    }

    func testThisIPhonesOwnIdAndMalformedRecordsAreNotComputers() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice }?.id)
        try sealReach(fake, mac, device: me, rev: 1)
        try sealReach(fake, mac, device: "dev-bad", routes: ["ftp://x", "http://y"], rev: 1)
        try sealReach(fake, mac, device: "dev-many", routes: (1...9).map { "wss://r\($0).example" }, rev: 1)
        try await p.sync()
        XCTAssertEqual(p.reach.map(\.deviceId), ["dev-many"])
        XCTAssertEqual(p.reach.first?.routes.count, 4, "at most four routes")
    }

    func testTheAccountLinkSealsTheHelloUnderTheCurrentEpoch() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        XCTAssertNil(p.accountLink(), "signed out")
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        try await p.restore(recoveryKey: mac.recovery.text)
        let link = try XCTUnwrap(p.accountLink())
        let me = try XCTUnwrap(p.devices.first { $0.thisDevice }?.id)
        XCTAssertEqual(link.deviceId, me)
        let b = FleetLink.Binding(room: "rm", challenge: "ch", hostEph: "he", clientEph: "ce", helloKey: "hk")
        let hello = try XCTUnwrap(link.hello(b))
        XCTAssertEqual(hello.str("accountId"), fake.account)
        XCTAssertEqual(hello.long("keyId"), 1)
        XCTAssertEqual(hello.str("deviceId"), me)
        // The computer, holding the same keyring, opens it with the account's associated data.
        let plain = try FleetLink.openHelloProof(keyring: mac.keyring, accountId: fake.account, keyId: 1, deviceId: me, blob: try XCTUnwrap(hello.str("proof")))
        XCTAssertEqual(try JSONValue.parse(plain).str("room"), "rm")
        await p.signOut()
        XCTAssertNil(p.accountLink())
    }

    func testAQuietSyncRunsOnlyWhenSignedInAndJoined() async throws {
        let fake = FakeCloud()
        let mac = try computer(fake)
        let p = phone(fake)
        await p.syncQuietly()
        XCTAssertEqual(fake.sessions, 0)
        try await p.verifyCode(email: "ada@example.com", code: "123456")
        await p.syncQuietly() // signed in, not joined: nothing to pull
        XCTAssertTrue(p.reach.isEmpty)
        try await p.restore(recoveryKey: mac.recovery.text)
        try sealReach(fake, mac, rev: 1)
        await p.syncQuietly()
        XCTAssertEqual(p.reach.count, 1)
    }
}

/// How the computers list takes `reach` records (decision 0128).
@MainActor
final class AccountComputersTests: XCTestCase {
    let room = "a1b2c3d4e5f60718"
    let key = "00112233445566778899aabbccddeeff"
    var connections: [FakeConnection] = []
    let secure = MemoryStore()

    func makeStore() -> ComputersStore {
        var n = 0
        let s = ComputersStore(
            store: secure,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                self.connections.append(c)
                return c
            },
            deviceName: { "Philip’s iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01)
        s.accountLink = { CloudSync.AccountLink(deviceId: "phone-acct") { b in .object(["v": .int(1), "deviceId": .string("phone-acct"), "room": .string(b.room)]) } }
        return s
    }

    func record(room: String? = nil, routes: [String] = ["wss://relay.nekko.example", "ws://studio.tail1.ts.net:4400"], device: String = "mac-acct",
                name: String = "Studio Mac") -> CloudSync.ReachRecord {
        CloudSync.reachRecord(.object(["v": .int(1), "deviceId": .string(device), "name": .string(name),
                                       "routes": .array(routes.map { .string($0) }), "room": .string(room ?? self.room),
                                       "secret": .string(key), "hostKey": .string(testHostKey)]))!
    }

    func settle() async { for _ in 0..<20 { await Task.yield() } }

    func testAPairedComputerGainsTheRecordsRoutesWithoutRewritingItsPairing() async throws {
        let s = makeStore()
        s.load()
        let id = try await s.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: room, key: key, hostKey: testHostKey, pair: nil))
        let saved = secure.get(ComputersStore.indexKey)
        XCTAssertEqual(connections.last?.config.routes, ["ws://studio.tail1.ts.net:4400"])
        await s.applyReach([record()])
        // The link is rebuilt with the cloud relay too, and the pairing (index and secret) is as it was.
        XCTAssertEqual(Set(connections.last?.config.routes ?? []), ["ws://studio.tail1.ts.net:4400", "wss://relay.nekko.example"])
        XCTAssertEqual(secure.get(ComputersStore.indexKey), saved)
        XCTAssertEqual(s.computers.map(\.id), [id], "no second computer for the same room")
        XCTAssertEqual(Set(s.dialRoutes(id)), ["ws://studio.tail1.ts.net:4400", "wss://relay.nekko.example"])
        XCTAssertEqual(connections.last?.config.deviceId, s.deviceId(), "a pairing keeps its own device id")
        XCTAssertNil(connections.last?.config.accountHello, "a pairing keeps the ordinary HELLO")
        // Gone, or a tombstone: the merged routes go.
        await s.applyReach([])
        XCTAssertEqual(s.dialRoutes(id), ["ws://studio.tail1.ts.net:4400"])
        XCTAssertEqual(connections.last?.config.routes, ["ws://studio.tail1.ts.net:4400"])
    }

    func testTheConnectThroughChoiceStillFiltersMergedRoutes() async throws {
        let s = makeStore()
        s.load()
        let id = try await s.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: room, key: key, hostKey: testHostKey, pair: nil))
        await s.applyReach([record()])
        s.setRouteChoice(id, .direct)
        XCTAssertEqual(s.dialRoutes(id), ["ws://studio.tail1.ts.net:4400"])
        s.setRouteChoice(id, .cloud)
        XCTAssertEqual(s.dialRoutes(id), ["wss://relay.nekko.example"])
        XCTAssertEqual(connections.last?.config.routes, ["wss://relay.nekko.example"])
    }

    func testARecordWithNoPairingIsAComputerFromYourAccountDialledWithTheAccountHello() async throws {
        let s = makeStore()
        s.load()
        await s.applyReach([record()])
        let c = try XCTUnwrap(s.computers.first)
        XCTAssertTrue(c.fromAccount)
        XCTAssertEqual(c.name, "Studio Mac")
        XCTAssertEqual(s.activeId, c.id, "with nothing paired, it is the one opened")
        let cfg = try XCTUnwrap(connections.last?.config)
        XCTAssertEqual(cfg.deviceId, "fleet:phone-acct")
        XCTAssertNil(cfg.pairCode)
        XCTAssertEqual(cfg.room, room)
        XCTAssertEqual(cfg.key, key)
        XCTAssertEqual(cfg.hostKey, testHostKey, "the host key is pinned as for a pairing")
        XCTAssertEqual(cfg.routes, ["wss://relay.nekko.example", "ws://studio.tail1.ts.net:4400"])
        let hello = try XCTUnwrap(cfg.accountHello?(FleetLink.Binding(room: room, challenge: "c", hostEph: "h", clientEph: "e", helloKey: "k")))
        XCTAssertEqual(hello.str("deviceId"), "phone-acct")
        // Never saved with the pairings, nothing to revoke.
        XCTAssertEqual(secure.get(ComputersStore.indexKey).flatMap { try? JSONValue.parse(Data($0.utf8)).array?.count }, nil)
        XCTAssertNil(secure.get(ComputersStore.secretKey(c.id)))
        let heard = await s.signOut(c.id)
        XCTAssertFalse(heard)
        XCTAssertEqual(s.computers.count, 1, "signing out of a pairing does not apply to it")
        // A tombstone (or signing out of Nekko Cloud) takes it away.
        await s.applyReach([])
        XCTAssertTrue(s.computers.isEmpty)
        XCTAssertNil(s.activeId)
    }

    func testPairingTheSameComputerLaterReplacesTheAccountEntry() async throws {
        let s = makeStore()
        s.load()
        await s.applyReach([record()])
        XCTAssertEqual(s.computers.filter(\.fromAccount).count, 1)
        let id = try await s.pair(PairingLink(relayUrl: "wss://relay.nekko.example", room: room, key: key, hostKey: testHostKey, pair: nil))
        XCTAssertEqual(s.computers.map(\.id), [id])
        XCTAssertFalse(try XCTUnwrap(s.computers.first).fromAccount)
        XCTAssertEqual(s.activeId, id)
    }

    func testPushEnrolmentCountsPairingsOnly() async throws {
        let s = makeStore()
        s.load()
        _ = try await s.pair(PairingLink(relayUrl: "wss://relay.example", room: room, key: key, hostKey: testHostKey, pair: nil))
        let before = s.pushBadgeRooms
        await s.applyReach([record(room: "other-room-0001", device: "mac-two")])
        XCTAssertEqual(s.computers.count, 2)
        XCTAssertEqual(s.pushBadgeRooms, before)
    }

    func testAStaleRefusalIsTriedAgainAfterASyncButAnOffSwitchIsNot() async throws {
        let s = makeStore()
        var syncs = 0
        s.accountCatchUp = { syncs += 1 }
        s.load()
        await s.applyReach([record()])
        let id = try XCTUnwrap(s.computers.first?.id)
        let first = try XCTUnwrap(connections.last)
        first.status(RelayStatus(.denied, detail: "fleet-off", denied: .fleetOff))
        await settle()
        XCTAssertEqual(syncs, 0, "the owner turned it off: nothing to retry")
        s.noteAccountStatus(id, RelayStatus(.denied, detail: "fleet-epoch", denied: .fleetEpoch))
        await settle()
        XCTAssertEqual(syncs, 1)
        s.noteAccountStatus(id, RelayStatus(.denied, detail: "fleet-device", denied: .fleetDevice))
        s.noteAccountStatus(id, RelayStatus(.denied, detail: "fleet-device", denied: .fleetDevice))
        await settle()
        XCTAssertEqual(syncs, 2, "at most two tries")
    }

    func testRefusalsAreSaidInPlainWords() {
        let facts = ConnectionFacts(id: "a", name: "Studio", state: .denied, denied: .fleetOff)
        let note = ConnectionNotes.make([facts], tailscaleOn: true).first
        XCTAssertEqual(note?.line, "Studio doesn’t let devices on your Nekko Cloud account connect without pairing.")
        XCTAssertTrue(note?.actions.contains(.pairAgain) == true)
        for r in [DenyReason.fleetDevice, .fleetEpoch, .fleetAccount, .fleetLocked] {
            let n = ConnectionNotes.make([ConnectionFacts(id: "a", name: "Studio", state: .denied, denied: r)], tailscaleOn: true).first
            XCTAssertEqual(n?.line, FleetLink.refusalText(r, computer: "Studio"))
        }
    }
}
