import Foundation
import XCTest
@testable import NekkoProtocol

/// Relay replay protection (phone protocol 4): the challenge, the HELLO that
/// answers it, and the seq and challenge on every request after the welcome.
/// Checked against `crates/nekko-remote/tests/golden/relay-handshake.json`,
/// which the computer (nekko-remote) and Android are held to as well.
extension RelayClientTests {
    struct HandshakeFixture {
        let g: JSONValue
        let keyBytes: Data

        var room: String { g.str("room")! }
        var secret: String { g.str("secret")! }
        var device: JSONValue { g["device"]! }
        var blob: String { g["challenge"]!.str("blob")! }
        var nonce: String { g["challenge"]!["frame"]!.str("challenge")! }
    }

    func handshakeFixture() throws -> HandshakeFixture {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/tests/golden/relay-handshake.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available at \(file.path)") }
        let g = try JSONValue.parse(data)
        let key = try XCTUnwrap(g.str("key").flatMap(E2E.fromHex))
        return HandshakeFixture(g: g, keyBytes: key)
    }

    /// A client configured as the fixture's phone, against a fake that never
    /// challenges by itself (the test feeds the fixture's sealed challenge).
    func fixtureClient(_ f: HandshakeFixture, challengeWait: TimeInterval) -> (RelayClient, Recorder, FakeRelay) {
        let relay = FakeRelay(key: f.keyBytes, known: [f.device.str("deviceId")!])
        relay.challenges = false
        var cfg = RelayConfig(relayUrl: "wss://relay.test", room: f.room, key: f.secret, keyBytes: f.keyBytes,
                              deviceId: f.device.str("deviceId")!, deviceName: f.device.str("name")!,
                              platform: f.device.str("platform")!)
        cfg.handshakeTimeout = 2
        cfg.requestTimeout = 2
        cfg.retryBase = 0.02
        cfg.retryMax = 0.08
        cfg.challengeWait = challengeWait
        let c = RelayClient(config: cfg, transport: relay)
        let r = Recorder()
        r.attach(c)
        return (c, r, relay)
    }

    func waitOpen(_ relay: FakeRelay, timeout: TimeInterval = 2) async -> FakeRelay.Conn? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let c = relay.sync({ relay.current }), c.isOpen { return c }
            await sleep(0.005)
        }
        XCTFail("the socket never opened")
        return nil
    }

    func testTheFixtureKeyAndChallengeOpen() throws {
        let f = try handshakeFixture()
        XCTAssertEqual(E2E.toHex(E2E.deriveKey(secret: f.secret, room: f.room)), f.g.str("key"))
        XCTAssertEqual(try E2E.open(key: f.keyBytes, blob: f.blob), f.g["challenge"]!["frame"]!)
        XCTAssertEqual(f.g.long("protocol"), Int64(PhoneProtocol.version))
    }

    func testAnswersTheFixtureChallengeWithTheFixtureHelloThenNumbersRequests() async throws {
        let f = try handshakeFixture()
        let (c, r, relay) = fixtureClient(f, challengeWait: 5)
        c.connect()
        let opened = await waitOpen(relay)
        let conn = try XCTUnwrap(opened)
        // No HELLO until the computer's challenge arrives.
        await sleep(0.1)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 0)
        conn.handlers.onMessage(JSONValue.object(["enc": .string(f.blob)]).serialized())
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos }, [f.g["hello"]!])

        _ = try await c.call(Channels.sessionsSummaries, [])
        _ = try await c.call(Channels.sessionGet, ["s1"])
        XCTAssertEqual(relay.sync { relay.requests }, f.g["requests"]!.array!)
        XCTAssertEqual(relay.sync { relay.rejected }, [])
        c.close()
    }

    func testAComputerThatNeverChallengesGetsTheLegacyHello() async throws {
        let f = try handshakeFixture()
        let (c, r, relay) = fixtureClient(f, challengeWait: 0.1)
        c.connect()
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos }, [f.g["legacyHello"]!])

        _ = try await c.call(Channels.sessionsSummaries, [])
        _ = try await c.call(Channels.sessionGet, ["s1"])
        let sent = relay.sync { relay.requests }
        XCTAssertEqual(sent.map { $0.long("seq") }, [1, 2])
        XCTAssertEqual(sent.map { $0["challenge"] }, [nil, nil])
        c.close()
    }

    func testAChallengeWhileOnlineRestartsTheHandshakeAndTheSeq() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { req in
            // chat:pending is held, so it is in flight across the new handshake.
            req.str("channel") == Channels.chatPending ? nil : ["type": "res", "id": req["id"]!, "result": "ok"]
        }
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        _ = try await c.call(Channels.appInfo)
        let held = Task { try await c.call(Channels.chatPending) }
        await sleep(0.05)
        let conn = try XCTUnwrap(relay.sync { relay.current })
        let first = try XCTUnwrap(relay.sync { relay.hellos.first?.str("challenge") })

        conn.challenge()
        await r.await(.online)
        let hellos = relay.sync { relay.hellos }
        XCTAssertEqual(hellos.count, 2)
        let second = try XCTUnwrap(hellos.last?.str("challenge"))
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(hellos.last?.long("protocol"), Int64(PhoneProtocol.version))

        _ = try await c.call(Channels.appInfo)
        let last = try XCTUnwrap(relay.sync { relay.requests.last })
        XCTAssertEqual(last.long("seq"), 1)
        XCTAssertEqual(last.str("challenge"), second)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1, "the same socket")

        // The call made before the reset is still waiting for its reply.
        let heldReq = try XCTUnwrap(relay.sync { relay.requests.first { $0.str("channel") == Channels.chatPending } })
        conn.push(["type": "res", "id": heldReq["id"]!, "result": "late"])
        let v = try await held.value
        XCTAssertEqual(v, "late")
        c.close()
    }

    func testOnceChallengedASocketWithoutAChallengeIsDialedAgain() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay, challengeWait: 0.05)
        c.connect()
        await r.await(.online)
        // The relay now hands this phone sockets the computer never challenges.
        relay.sync { relay.challenges = false }
        relay.sync { relay.current }!.drop(1006, "network")
        let deadline = Date().addingTimeInterval(3)
        while relay.sync({ relay.urls.count }) < 3, Date() < deadline { await sleep(0.01) }
        XCTAssertGreaterThanOrEqual(relay.sync { relay.urls.count }, 3, "redialed instead of falling back")
        XCTAssertNotEqual(c.state, .online)
        relay.sync { relay.challenges = true }
        await r.await(.online)
        // Never a legacy HELLO: every one answered a challenge.
        XCTAssertTrue(relay.sync { relay.hellos }.allSatisfy { $0.str("challenge") != nil && $0.long("protocol") == 4 })
        c.close()
    }

    func testAStaleRequestIsRejectedAndTheClientRecovers() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        _ = try await c.call(Channels.appInfo)
        // A replayed copy of that request (same seq) is dropped and re-challenged.
        let conn = try XCTUnwrap(relay.sync { relay.current })
        let replay = try XCTUnwrap(relay.sync { relay.requests.last })
        _ = conn.send(JSONValue.object(["enc": .string(try E2E.seal(key: key, value: replay))]).serialized())
        XCTAssertEqual(relay.sync { relay.rejected.count }, 1)
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        let v = try await c.call(Channels.appInfo)
        XCTAssertEqual(v, "ok:app:info")
        c.close()
    }

    func testALegacyHelloRefusedAsTooOldWaitsForTheChallengeInstead() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.challenges = false
        relay.refuseLegacy = true
        let (c, r) = client(relay, challengeWait: 0.05)
        c.connect()
        // The challenge was slow, the legacy HELLO went out, the computer refused it.
        let deadline = Date().addingTimeInterval(3)
        while relay.sync({ relay.urls.count }) < 3, Date() < deadline { await sleep(0.01) }
        XCTAssertGreaterThanOrEqual(relay.sync { relay.urls.count }, 3)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 1, "one legacy HELLO, never again")
        XCTAssertNotEqual(c.state, .denied)
        relay.sync { relay.challenges = true }
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos.last?.long("protocol") }, Int64(PhoneProtocol.version))
        c.close()
    }

    func testUpdateRequiredIsATerminalDenial() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.challenges = false
        let (c, r) = client(relay, challengeWait: 5)
        c.connect()
        let conn = await waitOpen(relay)
        conn?.push(["type": "denied", "reason": "update-required"])
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .updateRequired)
        XCTAssertEqual(DenyReason.parse("update-required"), .updateRequired)
    }
}
