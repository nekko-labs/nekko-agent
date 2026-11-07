import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
import XCTest
@testable import NekkoProtocol

/// The relay handshake (phone protocol 6, decision 0041): the signed challenge,
/// the session key, the HELLO that answers it, and the seq and challenge on
/// every request after the welcome. Checked against
/// `crates/nekko-remote/tests/golden/relay-handshake.json`, which the computer
/// (nekko-remote), Android and the browser are held to as well.
extension RelayClientTests {
    struct HandshakeFixture {
        let g: JSONValue
        let keyBytes: Data

        var room: String { g.str("room")! }
        var secret: String { g.str("secret")! }
        var device: JSONValue { g["device"]! }
        var blob: String { g["challenge"]!.str("blob")! }
        var frame: JSONValue { g["challenge"]!["frame"]! }
        var nonce: String { frame.str("challenge")! }
        var hostEph: String { frame.str("eph")! }
        var clientEph: String { g["clientEph"]!.str("publicKey")! }
        var hostKey: String { g["hostKey"]!.str("publicKey")! }

        func privateKey(_ name: String) throws -> Data { try XCTUnwrap(g[name]?.str("privateKeyHex").flatMap(E2E.fromHex)) }
        func ephemeral(_ name: String) throws -> Ephemeral { Ephemeral(key: try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey(name))) }
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

    /// A client configured as the fixture's phone, against a fake holding the
    /// fixture's keys that never challenges by itself (the test feeds the
    /// fixture's sealed challenge with `offer`).
    func fixtureClient(_ f: HandshakeFixture, challengeWait: TimeInterval, signer: HelloSigner? = nil) throws -> (RelayClient, Recorder, FakeRelay) {
        let host = try P256.Signing.PrivateKey(rawRepresentation: f.privateKey("hostKey"))
        let relay = FakeRelay(computer: TestComputer(room: f.room, roomKey: f.keyBytes, hostKey: host), known: [f.device.str("deviceId")!])
        relay.challenges = false
        var cfg = RelayConfig(relayUrl: "wss://relay.test", room: f.room, key: f.secret, hostKey: f.hostKey, keyBytes: f.keyBytes,
                              deviceId: f.device.str("deviceId")!, deviceName: f.device.str("name")!,
                              platform: f.device.str("platform")!)
        cfg.handshakeTimeout = 2
        cfg.requestTimeout = 2
        cfg.retryBase = 0.02
        cfg.retryMax = 0.08
        cfg.challengeWait = challengeWait
        cfg.helloSigner = signer
        let c = RelayClient(config: cfg, transport: relay)
        let r = Recorder()
        r.attach(c)
        return (c, r, relay)
    }

    /// Deliver the fixture's sealed challenge, the fake standing behind it.
    func offer(_ f: HandshakeFixture, on conn: FakeRelay.Conn) throws {
        let issued = TestComputer.Issued(nonce: f.nonce, eph: try f.ephemeral("hostEph"))
        conn.relay.sync { conn.issued = issued }
        conn.handlers.onMessage(JSONValue.object(["enc": .string(f.blob)]).serialized())
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

    func waitForDials(_ relay: FakeRelay, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while relay.sync({ relay.urls.count }) < n, Date() < deadline { await sleep(0.01) }
        XCTAssertGreaterThanOrEqual(relay.sync { relay.urls.count }, n, "redialed")
    }

    func testTheFixtureKeyAndChallengeOpen() throws {
        let f = try handshakeFixture()
        XCTAssertEqual(E2E.toHex(E2E.deriveKey(secret: f.secret, room: f.room)), f.g.str("key"))
        XCTAssertEqual(try E2E.open(key: f.keyBytes, blob: f.blob), f.frame)
        XCTAssertEqual(f.g.long("protocol"), Int64(PhoneProtocol.version))
    }

    /// Every derived value in the vector, from each end of the exchange.
    func testTheVectorsHandshake() throws {
        let f = try handshakeFixture()
        let deviceId = f.device.str("deviceId")!
        XCTAssertEqual(HostKey.text(room: f.room, challenge: f.nonce, eph: f.hostEph), f.g.str("hostText"))
        let info = HostKey.sessionInfo(room: f.room, challenge: f.nonce, hostEph: f.hostEph, clientEph: f.clientEph)
        XCTAssertEqual(info, f.g.str("sessionInfo"))
        let text = HelloKey.text(deviceId: deviceId, room: f.room, challenge: f.nonce, hostEph: f.hostEph, clientEph: f.clientEph)
        XCTAssertEqual(text, f.g["helloKey"]?.str("text"))

        let sig = try XCTUnwrap(f.frame.str("sig"))
        XCTAssertTrue(HostKey.verifies(f.hostKey, room: f.room, challenge: f.nonce, eph: f.hostEph, sig: sig))
        XCTAssertFalse(HostKey.verifies(f.hostKey, room: "another-room", challenge: f.nonce, eph: f.hostEph, sig: sig))
        XCTAssertFalse(HostKey.verifies(f.hostKey, room: f.room, challenge: f.nonce, eph: f.clientEph, sig: sig))
        XCTAssertFalse(HostKey.verifies(f.g["helloKey"]!.str("publicKey")!, room: f.room, challenge: f.nonce, eph: f.hostEph, sig: sig))
        XCTAssertFalse(HostKey.verifies("not a key", room: f.room, challenge: f.nonce, eph: f.hostEph, sig: sig))
        XCTAssertFalse(HostKey.verifies(f.hostKey, room: f.room, challenge: f.nonce, eph: f.hostEph, sig: "AAAA"))

        let (client, host) = (try f.ephemeral("clientEph"), try f.ephemeral("hostEph"))
        XCTAssertEqual(client.publicKey, f.clientEph)
        XCTAssertEqual(host.publicKey, f.hostEph)
        let session = try XCTUnwrap(client.sessionKey(theirs: f.hostEph, info: info))
        XCTAssertEqual(E2E.toHex(session), f.g.str("sessionKey"))
        XCTAssertEqual(host.sessionKey(theirs: f.clientEph, info: info), session)
        XCTAssertNil(client.sessionKey(theirs: "not a point", info: info))
        XCTAssertNil(client.sessionKey(theirs: Data(repeating: 4, count: 65).base64EncodedString(), info: info))

        XCTAssertEqual(f.g["helloFrame"]?.str("eph"), f.clientEph)
        XCTAssertEqual(try E2E.open(key: session, blob: f.g["helloFrame"]!.str("enc")!), f.g["hello"])
        XCTAssertThrowsError(try E2E.open(key: f.keyBytes, blob: f.g["helloFrame"]!.str("enc")!), "not under the room key")
    }

    /// The HELLO is signed with the device key over the shared text, and is otherwise the fixture's HELLO.
    func testTheHelloSignsTheSharedTextWithTheDeviceKey() async throws {
        let f = try handshakeFixture()
        let k = try XCTUnwrap(f.g["helloKey"])
        // The fixture's signature verifies with the fixture's key, as on the computer.
        let fixtureKey = try P256.Signing.PublicKey(x963Representation: XCTUnwrap(Data(base64Encoded: k.str("publicKey")!)))
        let fixtureSig = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(Data(base64Encoded: k.str("sig")!)))
        XCTAssertTrue(fixtureKey.isValidSignature(fixtureSig, for: Data(k.str("text")!.utf8)))

        let signer = SoftwareHelloSigner()
        let (c, r, relay) = try fixtureClient(f, challengeWait: 5, signer: signer)
        c.connect()
        let opened = await waitOpen(relay)
        try offer(f, on: XCTUnwrap(opened))
        await r.await(.online)
        let hello = try XCTUnwrap(relay.sync { relay.hellos.first })
        let key = try XCTUnwrap(hello.str("helloKey").flatMap { Data(base64Encoded: $0) })
        XCTAssertEqual(key, try signer.publicKey())
        let clientEph = try XCTUnwrap(relay.sync { relay.answers.first })
        let text = HelloKey.text(deviceId: f.device.str("deviceId")!, room: f.room, challenge: f.nonce, hostEph: f.hostEph, clientEph: clientEph)
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(hello.str("sig").flatMap { Data(base64Encoded: $0) }))
        XCTAssertTrue(signer.key.publicKey.isValidSignature(sig, for: Data(text.utf8)))
        c.close()
    }

    func testAnswersTheFixtureChallengeWithTheFixtureHelloThenNumbersRequests() async throws {
        let f = try handshakeFixture()
        let (c, r, relay) = try fixtureClient(f, challengeWait: 5)
        c.connect()
        let opened = await waitOpen(relay)
        let conn = try XCTUnwrap(opened)
        // No HELLO until the computer's challenge arrives.
        await sleep(0.1)
        XCTAssertEqual(relay.sync { relay.answers.count }, 0)
        try offer(f, on: conn)
        await r.await(.online)
        var expected = try XCTUnwrap(f.g["hello"]?.object)
        expected.removeValue(forKey: "helloKey") // this client has no signer
        expected.removeValue(forKey: "sig")
        XCTAssertEqual(relay.sync { relay.hellos }, [.object(expected)])

        _ = try await c.call(Channels.sessionsSummaries, [])
        _ = try await c.call(Channels.sessionGet, ["s1"])
        XCTAssertEqual(relay.sync { relay.requests }, f.g["requests"]!.array!)
        XCTAssertEqual(relay.sync { relay.rejected }, [])
        c.close()
    }

    func testLateOpenDoesNotDisconnectAWelcomedSocket() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.deferOpenCallback = true
        let (c, r) = client(relay, challengeWait: 0.05)
        defer { c.close() }
        c.connect()
        await r.await(.online)
        let conn = try XCTUnwrap(relay.sync { relay.current })
        // Simulate an open callback scheduled behind receive callbacks.
        conn.handlers.onOpen()
        await sleep(0.15)
        XCTAssertEqual(c.state, .online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1, "a late open must not re-arm the challenge watchdog")
        let reply = try await c.call(Channels.appInfo)
        XCTAssertEqual(reply, "ok:app:info")
    }

    func testLateOpenDoesNotShortenTheWelcomeDeadline() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.deferOpenCallback = true
        relay.silent = true
        let (c, _) = client(relay, challengeWait: 0.05)
        defer { c.close() }
        c.connect()
        let opened = await waitOpen(relay)
        let conn = try XCTUnwrap(opened)
        let deadline = Date().addingTimeInterval(1)
        while relay.sync({ relay.hellos.isEmpty }), Date() < deadline { await sleep(0.005) }
        XCTAssertEqual(relay.sync { relay.hellos.count }, 1)
        conn.handlers.onOpen()
        await sleep(0.15)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1, "HELLO already sent; wait for welcome, not another challenge")
        XCTAssertEqual(c.state, .connecting)
    }

    func testASocketWithNoChallengeFailsWithoutSendingTheCode() async {
        let relay = FakeRelay(key: key, code: "ABCD2345")
        relay.challenges = false
        let (c, r) = client(relay, pair: "ABCD2345", challengeWait: 0.05)
        c.connect()
        await waitForDials(relay, 3)
        XCTAssertEqual(relay.sync { relay.answers }, [], "no HELLO to a computer that never proved itself")
        XCTAssertNotEqual(c.state, .online)
        relay.sync { relay.challenges = true }
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos.map { $0.str("pair") } }, ["ABCD2345"], "the code is for the computer alone")
        c.close()
    }

    /// Anyone who ever held the room secret could send this: no HELLO and no
    /// denial, only a socket that failed like any other.
    func testAChallengeSignedByAnotherKeyGetsNoHello() async {
        let relay = FakeRelay(key: key, code: "ABCD2345")
        relay.forger = P256.Signing.PrivateKey()
        let (c, r) = client(relay, pair: "ABCD2345", challengeWait: 0.05)
        c.connect()
        await waitForDials(relay, 3)
        XCTAssertEqual(relay.sync { relay.answers }, [])
        XCTAssertFalse(r.lock.sync { r.statuses.contains { $0.state == .denied } })
        relay.sync { relay.forger = nil }
        await r.await(.online)
        c.close()
    }

    func testAForgedChallengeOnALiveSocketChangesNothing() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let conn = try XCTUnwrap(relay.sync { relay.current })
        conn.pushRoom(relay.computer.issue(signer: P256.Signing.PrivateKey()).frame)
        conn.pushRoom(["type": "challenge", "challenge": "bm9uY2U=", "eph": "AAAA"])
        await sleep(0.05)
        XCTAssertEqual(c.state, .online)
        XCTAssertEqual(relay.sync { relay.answers.count }, 1)
        let v = try await c.call(Channels.appInfo)
        XCTAssertEqual(v, "ok:app:info")
        c.close()
    }

    /// The security property: holding the room secret, as a revoked device may,
    /// neither ends a live link nor answers its calls nor feeds it events.
    func testOnlyAChallengeCountsUnderTheRoomKey() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil }
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let conn = try XCTUnwrap(relay.sync { relay.current })
        let held = Task { try await c.call(Channels.chatPending) }
        await sleep(0.05)
        let id = try XCTUnwrap(relay.sync { relay.requests.first?["id"] })

        conn.pushRoom(["type": "denied", "reason": "revoked"])
        conn.pushRoom(["type": "res", "id": id, "result": "forged"])
        conn.pushRoom(["type": "event", "channel": .string(Events.agentEvent), "payload": ["type": "text", "sessionId": "s", "delta": "forged"]])
        conn.pushRoom(["type": "welcome", "device": ["id": "dev-1"]])
        await sleep(0.05)
        XCTAssertEqual(c.state, .online)
        XCTAssertEqual(r.lock.sync { r.statuses.map(\.state) }.filter { $0 == .denied }, [])
        XCTAssertEqual(r.lock.sync { r.events.count }, 0)
        XCTAssertEqual(r.lock.sync { r.welcomes.count }, 1)

        conn.push(["type": "res", "id": id, "result": "real"])
        let v = try await held.value
        XCTAssertEqual(v, "real", "the call waited for the computer's answer")
        c.close()
    }

    func testARoomKeyFrameCanNotWelcomeOrDenyDuringTheHandshake() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.challenges = false
        let (c, r) = client(relay, challengeWait: 5)
        c.connect()
        let opened = await waitOpen(relay)
        let conn = try XCTUnwrap(opened)
        conn.pushRoom(["type": "welcome", "device": ["id": "dev-1"]])
        conn.pushRoom(["type": "denied", "reason": "update-required"])
        await sleep(0.05)
        XCTAssertEqual(c.state, .connecting)
        conn.challenge()
        await r.await(.online)
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
        let oldKey = try XCTUnwrap(relay.sync { conn.session })

        conn.challenge()
        await r.await(.online)
        let hellos = relay.sync { relay.hellos }
        XCTAssertEqual(hellos.count, 2)
        let second = try XCTUnwrap(hellos.last?.str("challenge"))
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(hellos.last?.long("protocol"), Int64(PhoneProtocol.version))
        XCTAssertEqual(Set(relay.sync { relay.answers }).count, 2, "a new ephemeral key for every challenge")

        _ = try await c.call(Channels.appInfo)
        let last = try XCTUnwrap(relay.sync { relay.requests.last })
        XCTAssertEqual(last.long("seq"), 1)
        XCTAssertEqual(last.str("challenge"), second)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1, "the same socket")

        // The old key went with the old handshake.
        conn.pushSealed(["type": "event", "channel": .string(Events.agentEvent), "payload": ["type": "text", "sessionId": "s", "delta": "old"]], key: oldKey)
        await sleep(0.05)
        XCTAssertEqual(r.lock.sync { r.events.count }, 0)

        // The call made before the reset is still waiting for its reply.
        let heldReq = try XCTUnwrap(relay.sync { relay.requests.first { $0.str("channel") == Channels.chatPending } })
        conn.push(["type": "res", "id": heldReq["id"]!, "result": "late"])
        let v = try await held.value
        XCTAssertEqual(v, "late")
        c.close()
    }

    func testOnceOnlineASocketWithoutAChallengeIsDialedAgain() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay, challengeWait: 0.05)
        c.connect()
        await r.await(.online)
        // The relay now hands this phone sockets the computer never challenges.
        relay.sync { relay.challenges = false }
        relay.sync { relay.current }!.drop(1006, "network")
        await waitForDials(relay, 3)
        XCTAssertNotEqual(c.state, .online)
        relay.sync { relay.challenges = true }
        await r.await(.online)
        XCTAssertTrue(relay.sync { relay.hellos }.allSatisfy { $0.str("challenge") != nil && $0.long("protocol") == Int64(PhoneProtocol.version) })
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
        let session = try XCTUnwrap(relay.sync { conn.session })
        _ = conn.send(JSONValue.object(["enc": .string(try E2E.seal(key: session, value: replay))]).serialized())
        XCTAssertEqual(relay.sync { relay.rejected.count }, 1)
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        let v = try await c.call(Channels.appInfo)
        XCTAssertEqual(v, "ok:app:info")
        c.close()
    }

    /// A replayed challenge is genuine, and nobody is behind it.
    func testAHelloThatGetsNoWelcomeFailsTheRoute() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.silent = true
        let (c, r) = client(relay, handshakeTimeout: 0.05)
        c.connect()
        await waitForDials(relay, 2)
        XCTAssertGreaterThanOrEqual(relay.sync { relay.hellos.count }, 1, "the first socket got its HELLO")
        XCTAssertNotEqual(c.state, .online)
        relay.sync { relay.silent = false }
        await r.await(.online)
        c.close()
    }

    func testANewChallengeRestartsTheWaitForTheWelcome() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.silent = true
        let (c, r) = client(relay, handshakeTimeout: 0.4)
        c.connect()
        await sleep(0.25)
        let conn = try XCTUnwrap(relay.sync { relay.current })
        conn.challenge()
        await sleep(0.25)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1, "the second HELLO has its own time")
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        await waitForDials(relay, 2)
        relay.sync { relay.silent = false }
        await r.await(.online)
        c.close()
    }

    func testAWelcomeCancelsTheWaitForIt() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay, handshakeTimeout: 0.05)
        c.connect()
        await r.await(.online)
        await sleep(0.15)
        XCTAssertEqual(c.state, .online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1)
        c.close()
    }

    func testUpdateRequiredIsATerminalDenial() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        relay.sync { relay.current }!.push(["type": "denied", "reason": "update-required"])
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .updateRequired)
        XCTAssertEqual(DenyReason.parse("update-required"), .updateRequired)
    }
}
