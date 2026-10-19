import Foundation
import XCTest
@testable import NekkoProtocol

/// The relay client against an in-memory relay + agent. The fake plays the
/// agent's side of `packages/host/src/relay.ts`: it opens sealed frames with
/// the room key, answers HELLO and replies to requests. Same cases as
/// Android's `RelayClientTest.kt`.
final class RelayClientTests: XCTestCase {
    let key = E2E.randomBytes(32)

    final class FakeRelay: WsTransport, @unchecked Sendable {
        let key: Data
        let lock = NSLock()
        var known: Set<String>
        var code: String?
        var urls: [String] = []
        var hellos: [JSONValue] = []
        var requests: [JSONValue] = []
        var registrations: [JSONValue] = []
        var current: Conn?
        var refuseNext: (Int, String)?
        /// The computer's phone protocol version in its welcome; nil sends none (an older computer).
        var welcomeProtocol: Int?
        var answer: (JSONValue) -> JSONValue? = { req in
            ["type": "res", "id": req["id"]!, "result": .string("ok:\(req.str("channel")!)")]
        }

        init(key: Data, known: Set<String> = [], code: String? = nil) {
            self.key = key
            self.known = known
            self.code = code
        }

        func sync<T>(_ body: () -> T) -> T {
            lock.lock()
            defer { lock.unlock() }
            return body()
        }

        final class Conn: WsConnection, @unchecked Sendable {
            let relay: FakeRelay
            let handlers: WsHandlers
            let refuse: (Int, String)?
            private let lock = NSLock()
            private var _open = false
            var isOpen: Bool { lock.lock(); defer { lock.unlock() }; return _open }

            init(relay: FakeRelay, handlers: WsHandlers, refuse: (Int, String)?) {
                self.relay = relay
                self.handlers = handlers
                self.refuse = refuse
            }

            func start() {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.005) {
                    if let (code, reason) = self.refuse {
                        self.handlers.onClosed(code, reason)
                        return
                    }
                    self.lock.lock()
                    self._open = true
                    self.lock.unlock()
                    self.handlers.onOpen()
                }
            }

            func send(_ text: String) -> Bool {
                guard isOpen, let env = try? JSONValue.parse(text) else { return false }
                if env.str("type") == "register-push" || env.str("type") == "register-activity" {
                    relay.sync { relay.registrations.append(env) }
                    return true
                }
                guard let frame = try? E2E.open(key: relay.key, blob: env.str("enc")!) else { return false }
                switch frame.str("type") {
                case "hello":
                    let id = frame.str("deviceId")!
                    let pair = frame.str("pair")
                    let reply: String? = relay.sync {
                        relay.hellos.append(frame)
                        if relay.known.contains(id) { return nil }
                        if let pair, pair == relay.code {
                            relay.known.insert(id)
                            relay.code = nil
                            return nil
                        }
                        return pair != nil ? "bad-code" : "unknown-device"
                    }
                    if let reply {
                        push(["type": "denied", "reason": .string(reply)])
                        drop(4001, "kicked by agent")
                    } else {
                        var welcome: [String: JSONValue] = ["type": "welcome", "device": ["id": .string(id), "name": frame["name"]!, "platform": "ios"]]
                        if let v = relay.sync({ relay.welcomeProtocol }) { welcome["protocol"] = .int(Int64(v)) }
                        push(.object(welcome))
                    }
                case "req":
                    let a = relay.sync { () -> JSONValue? in
                        relay.requests.append(frame)
                        return relay.answer(frame)
                    }
                    if let a { push(a) }
                default:
                    break
                }
                return true
            }

            func close(code: Int, reason: String) { drop(code, reason) }

            func push(_ frame: JSONValue) {
                let sealed = try! E2E.seal(key: relay.key, value: frame)
                handlers.onMessage(JSONValue.object(["enc": .string(sealed)]).serialized())
            }

            func plain(_ frame: JSONValue) { handlers.onMessage(frame.serialized()) }

            func drop(_ code: Int, _ reason: String) {
                lock.lock()
                let was = _open
                _open = false
                lock.unlock()
                if was { handlers.onClosed(code, reason) }
            }
        }

        func open(url: URL, handlers: WsHandlers) throws -> WsConnection {
            sync {
                urls.append(url.absoluteString)
                let c = Conn(relay: self, handlers: handlers, refuse: refuseNext)
                refuseNext = nil
                current = c
                return c
            }
        }
    }

    /// Records every status the client reports, in order.
    final class Recorder: @unchecked Sendable {
        let lock = NSLock()
        var statuses: [RelayStatus] = []
        var events: [(String, JSONValue)] = []
        var welcomes: [WelcomedDevice] = []
        var cursor = 0

        func attach(_ c: RelayClient) {
            c.setHandlers(
                onStatus: { s in self.lock.lock(); self.statuses.append(s); self.lock.unlock() },
                onEvent: { ch, p in self.lock.lock(); self.events.append((ch, p)); self.lock.unlock() },
                onWelcome: { d in self.lock.lock(); self.welcomes.append(d); self.lock.unlock() })
        }

        /// Wait for the next status (after the last one awaited) matching `match`.
        @discardableResult
        func await(_ match: @escaping (RelayStatus) -> Bool, timeout: TimeInterval = 3, file: StaticString = #filePath, line: UInt = #line) async -> RelayStatus? {
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if let s = next(match) { return s }
                try? await Task.sleep(nanoseconds: 5_000_000)
            }
            let seen = lock.sync { statuses.map { "\($0.state)(\($0.detail ?? ""))" } }
            XCTFail("status never matched; saw \(seen)", file: file, line: line)
            return nil
        }

        private func next(_ match: (RelayStatus) -> Bool) -> RelayStatus? {
            lock.sync {
                guard let i = statuses.indices.dropFirst(cursor).first(where: { match(statuses[$0]) }) else { return nil }
                cursor = i + 1
                return statuses[i]
            }
        }

        @discardableResult
        func await(_ state: RelayState, file: StaticString = #filePath, line: UInt = #line) async -> RelayStatus? {
            await self.await({ $0.state == state }, file: file, line: line)
        }
    }

    func client(_ relay: FakeRelay, pair: String? = nil, id: String = "dev-1", retryBase: TimeInterval = 0.02,
                retryMax: TimeInterval = 0.08) -> (RelayClient, Recorder) {
        var cfg = RelayConfig(relayUrl: "wss://relay.test/", room: "abcd1234", key: "k&e+y", keyBytes: key, deviceId: id,
                              deviceName: "iPhone", pairCode: pair)
        cfg.handshakeTimeout = 2
        cfg.requestTimeout = 2
        cfg.retryBase = retryBase
        cfg.retryMax = retryMax
        cfg.offlinePoll = 0.04
        let c = RelayClient(config: cfg, transport: relay)
        let r = Recorder()
        r.attach(c)
        return (c, r)
    }

    func sleep(_ s: TimeInterval) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }

    func testEnrollsWithTheOneTimeCodeThenNeverResendsIt() async {
        let relay = FakeRelay(key: key, code: "ABCD2345")
        let (c, r) = client(relay, pair: "ABCD2345")
        c.connect()
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.urls }, ["wss://relay.test/relay?role=client&room=abcd1234&key=k%26e%2By"])
        XCTAssertEqual(relay.sync { relay.hellos.first?.str("pair") }, "ABCD2345")
        await sleep(0.02)
        XCTAssertEqual(r.lock.sync { r.welcomes.first?.name }, "iPhone")

        // Drop the socket: the reconnect HELLO must not carry the spent code.
        relay.sync { relay.current }!.drop(1006, "network")
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        XCTAssertNil(relay.sync { relay.hellos[1]["pair"] })
        c.close()
    }

    func testCallsChannelsWithSealedRequestsAndResolvesReplies() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, _) = client(relay)
        c.connect()
        let v = try await c.call(Channels.appInfo, ["x"])
        XCTAssertEqual(v, "ok:app:info")
        XCTAssertEqual(relay.sync { relay.requests.first?["args"] }, ["x"])
        c.close()
    }

    func testHostErrorsRejectTheCall() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { req in ["type": "res", "id": req["id"]!, "error": "no such session"] }
        let (c, _) = client(relay)
        c.connect()
        do {
            _ = try await c.call(Channels.sessionGet, ["s"])
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? RelayError, RelayError("no such session"))
        }
        c.close()
    }

    func testDeliversEventsAndIgnoresFramesSealedWithAnotherKey() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let conn = relay.sync { relay.current }!
        let wrong = try E2E.seal(key: E2E.randomBytes(32), value: ["type": "event", "channel": "x"])
        conn.handlers.onMessage(JSONValue.object(["enc": .string(wrong)]).serialized())
        conn.handlers.onMessage("not json")
        conn.push(["type": "event", "channel": .string(Events.agentEvent), "payload": ["type": "text", "sessionId": "s", "delta": "hi"]])
        await sleep(0.05)
        let events = r.lock.sync { r.events }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.0, Events.agentEvent)
        XCTAssertEqual(AgentEvent.from(events.first?.1), .text(sessionId: "s", delta: "hi"))
        c.close()
    }

    func testAStrangerIsDeniedAndStaysDenied() async {
        let relay = FakeRelay(key: key)
        let (c, r) = client(relay)
        c.connect()
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .unknownDevice)
        await sleep(0.15)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1) // no reconnect loop after a denial
        do {
            _ = try await c.call(Channels.appInfo)
            XCTFail("should throw")
        } catch {
            XCTAssertTrue((error as? RelayError)?.message.contains("no longer paired") == true)
        }
    }

    func testAWrongPairingCodeIsDeniedAsBadCode() async {
        let (c, r) = client(FakeRelay(key: key, code: "RIGHT234"), pair: "WRONG234")
        c.connect()
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .badCode)
    }

    func testKickIsTerminalAndFailsInFlightCalls() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil } // never answer
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let inflight = Task { () -> Error? in
            do { _ = try await c.call(Channels.chatPending); return nil } catch { return error }
        }
        await sleep(0.05)
        relay.sync { relay.current }!.drop(4001, "kicked by agent")
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .kicked)
        let e = await inflight.value
        XCTAssertNotNil(e as? RelayError)
    }

    func testABadPairingKeyIsTerminal() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.refuseNext = (1008, "bad pairing key")
        let (c, r) = client(relay)
        c.connect()
        let s = await r.await(.denied)
        XCTAssertEqual(s?.denied, .badKey)
    }

    func testAnOfflineComputerIsPolledThenTheHandshakeCompletes() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.refuseNext = (1008, "room not paired (agent offline)")
        let (c, r) = client(relay)
        c.connect()
        await r.await(.offline)
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 2)
        c.close()
    }

    func testAgentOfflineThenOnlineRepeatsTheHandshakeOnTheSameSocket() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let conn = relay.sync { relay.current }!
        conn.plain(["type": "agent-offline"])
        await r.await(.offline)
        conn.plain(["type": "agent-online"])
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        c.close()
    }

    func testReconnectDropsALiveSocketAndDialsAFreshOne() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil }
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        let old = relay.sync { relay.current }!
        let inflight = Task { () -> Error? in
            do { _ = try await c.call(Channels.chatPending); return nil } catch { return error }
        }
        await sleep(0.05)
        c.reconnect()
        let e = await inflight.value
        XCTAssertNotNil(e as? RelayError)
        XCTAssertFalse(old.isOpen)
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 2)
        XCTAssertEqual(relay.sync { relay.hellos.count }, 2)
        // The old socket's late close must not schedule another dial.
        await sleep(0.15)
        XCTAssertEqual(relay.sync { relay.urls.count }, 2)
        c.close()
    }

    func testReconnectSkipsTheBackoffWhileTheRelayIsUnreachable() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.refuseNext = (1006, "network down")
        let (c, r) = client(relay, retryBase: 60, retryMax: 60)
        c.connect()
        await r.await({ $0.state == .connecting && $0.detail == "network down" })
        c.reconnect() // without it the next try would be a minute away
        await r.await(.online)
        XCTAssertEqual(relay.sync { relay.urls.count }, 2)
        c.close()
    }

    func testReconnectDoesNothingOnceClosedOrDenied() async {
        let closed = FakeRelay(key: key, known: ["dev-1"])
        let (a, ra) = client(closed)
        a.connect()
        await ra.await(.online)
        a.close()
        a.reconnect()
        await sleep(0.1)
        XCTAssertEqual(closed.sync { closed.urls.count }, 1)
        XCTAssertEqual(a.state, .idle)

        let stranger = FakeRelay(key: key)
        let (b, rb) = client(stranger)
        b.connect()
        await rb.await(.denied)
        b.reconnect()
        await sleep(0.1)
        XCTAssertEqual(stranger.sync { stranger.urls.count }, 1)
        XCTAssertEqual(b.state, .denied)
    }

    func testCloseStopsReconnectingAndRejectsNewCalls() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, r) = client(relay)
        c.connect()
        await r.await(.online)
        c.close()
        XCTAssertEqual(c.state, .idle)
        await sleep(0.15)
        XCTAssertEqual(relay.sync { relay.urls.count }, 1)
        do {
            _ = try await c.call(Channels.appInfo)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? RelayError, RelayError("Not connected."))
        }
    }

    func testRegistersPushAsAnUnsealedControlFrame() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, _) = client(relay)
        c.connect()
        try await c.registerPush(token: "abcdef0123456789abcdef")
        let reg = relay.sync { relay.registrations.first }
        XCTAssertEqual(reg?.str("token"), "abcdef0123456789abcdef")
        XCTAssertEqual(reg?.str("platform"), "ios")
        XCTAssertEqual(reg?.str("deviceId"), "dev-1")
        c.close()
    }

    func testTheHelloCarriesThePhonesProtocolAndTheWelcomeTheComputers() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.welcomeProtocol = 3
        let (c, r) = client(relay)
        c.connect()
        _ = try await c.call(Channels.appInfo)
        XCTAssertEqual(relay.sync { relay.hellos.first?.long("protocol") }, Int64(PhoneProtocol.version))
        XCTAssertEqual(r.lock.sync { r.welcomes.last?.protocolVersion }, 3)
        c.close()
        // A computer from before the field: version 1.
        let old = FakeRelay(key: key, known: ["dev-1"])
        let (c2, r2) = client(old)
        c2.connect()
        _ = try await c2.call(Channels.appInfo)
        XCTAssertEqual(r2.lock.sync { r2.welcomes.last?.protocolVersion }, 1)
        c2.close()
    }

    func testRegistersPushKindsAndHearsTheRelaysOwnFrames() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        let (c, _) = client(relay)
        let seen = Seen()
        c.setControlHandler { control in seen.add(control) }
        c.connect()
        try await c.registerPush(token: "abcdef0123456789abcdef", kinds: ["needs-you", "failed"])
        try await c.registerPush(token: "abcdef0123456789abcdef")
        let regs = relay.sync { relay.registrations }
        XCTAssertEqual(regs.first?["kinds"], ["needs-you", "failed"])
        // Without kinds the relay pushes every kind, as for older phones.
        XCTAssertNil(regs.last?["kinds"])
        let conn = try XCTUnwrap(relay.sync { relay.current })
        conn.plain(["type": "push-registered", "delivers": true])
        conn.plain(["type": "dismiss", "tag": .string(E2E.activityTag("s1"))])
        conn.plain(["type": "dismiss", "tag": "not a tag"])
        conn.plain(["type": "mystery"])
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(seen.all, [.pushRegistered(delivers: true), .dismiss(tag: E2E.activityTag("s1"))])
        // The plain frames changed nothing else: still online.
        XCTAssertEqual(c.state, .online)
        c.close()
    }

    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [RelayControl] = []
        func add(_ c: RelayControl) { lock.sync { items.append(c) } }
        var all: [RelayControl] { lock.sync { items } }
    }

    func testRegistersALiveActivityUnderItsTag() async throws {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        var cfg = RelayConfig(relayUrl: "wss://relay.test", room: "abcd1234", key: "k", keyBytes: key, deviceId: "dev-1", deviceName: "iPhone")
        cfg.app = "com.nekko.native.ios"
        let c = RelayClient(config: cfg, transport: relay)
        c.connect()
        try await c.registerActivity(tag: E2E.activityTag("s1"), token: "ab12")
        try await c.registerPush(token: "abcdef0123456789abcdef")
        let regs = relay.sync { relay.registrations }
        XCTAssertEqual(regs.first?.str("type"), "register-activity")
        XCTAssertEqual(regs.first?.str("tag"), "7536af24f84b356f893a72f0def58cce")
        XCTAssertEqual(regs.first?.str("app"), "com.nekko.native.ios")
        XCTAssertEqual(regs.last?.str("app"), "com.nekko.native.ios")
        c.close()
    }

    func testARequestThatGetsNoReplyTimesOut() async {
        let relay = FakeRelay(key: key, known: ["dev-1"])
        relay.answer = { _ in nil }
        let (c, _) = client(relay)
        c.connect()
        do {
            _ = try await c.call(Channels.modelsList, ["p"], timeout: 0.1)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? RelayError, RelayError("models:list: timed out"))
        }
        c.close()
    }
}

extension NSLock {
    func sync<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
