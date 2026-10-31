import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

final class MemoryStore: SecureStore, @unchecked Sendable {
    let lock = NSLock()
    var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func set(_ key: String, _ value: String?) { lock.lock(); values[key] = value; lock.unlock() }
}

/// A scripted computer: answers channels from `replies`, records calls, and
/// lets the test push status changes and events like the relay client would.
final class FakeConnection: RemoteConnection, @unchecked Sendable {
    let config: RelayConfig
    let lock = NSLock()
    var calls: [(String, [JSONValue])] = []
    var replies: [String: ([JSONValue]) throws -> JSONValue] = [:]
    var summariesReply: (@MainActor () async throws -> JSONValue)?
    var connected = false
    var closed = false
    var pushTokens: [String] = []
    private var onStatus: (@Sendable (RelayStatus) -> Void)?
    private var onEvent: (@Sendable (String, JSONValue) -> Void)?
    private var onWelcome: (@Sendable (WelcomedDevice) -> Void)?

    init(config: RelayConfig) { self.config = config }

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        self.onStatus = onStatus
        self.onEvent = onEvent
        self.onWelcome = onWelcome
    }

    var connects = 0
    var paths: [NetworkPath] = []
    /// Called on every connect (a hello probe answers from here).
    var onConnect: ((FakeConnection) -> Void)?
    func connect() {
        lock.lock(); connected = true; closed = false; connects += 1; lock.unlock()
        onConnect?(self)
    }
    func close() { lock.lock(); closed = true; lock.unlock() }
    func nudge() {}
    func reconnect() {}
    func networkChanged(_ path: NetworkPath) { lock.lock(); paths.append(path); lock.unlock() }
    func setNetworkPath(_ path: NetworkPath) { lock.lock(); paths.append(path); lock.unlock() }
    func registerPush(token: String) async throws { try await registerPush(token: token, kinds: nil) }
    var pushKinds: [[String]?] = []
    func registerPush(token: String, kinds: [String]?) async throws {
        lock.lock(); pushTokens.append(token); pushKinds.append(kinds); lock.unlock()
    }
    private var onControl: (@Sendable (RelayControl) -> Void)?
    func setControlHandler(_ f: (@Sendable (RelayControl) -> Void)?) { onControl = f }
    func control(_ c: RelayControl) { onControl?(c) }
    /// The computer's protocol version in its welcome.
    var welcomeProtocol = 1
    var cards: [JSONValue] = []
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {
        lock.lock()
        cards.append(["token": token.map(JSONValue.string) ?? .null, "startToken": startToken.map(JSONValue.string) ?? .null,
                      "level": .string(level.rawValue), "computerId": .string(computerId), "computerName": .string(computerName)])
        lock.unlock()
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        lock.lock()
        calls.append((channel, args))
        let r = replies[channel]
        lock.unlock()
        if channel == Channels.sessionsSummaries, let summariesReply { return try await summariesReply() }
        guard let r else { return .null }
        return try r(args)
    }

    func callsTo(_ channel: String) -> [[JSONValue]] {
        lock.lock(); defer { lock.unlock() }
        return calls.filter { $0.0 == channel }.map(\.1)
    }

    func online() {
        onWelcome?(WelcomedDevice(id: config.deviceId, name: config.deviceName, platform: "ios", protocolVersion: welcomeProtocol))
        onStatus?(RelayStatus(.online))
    }

    func status(_ s: RelayStatus) { onStatus?(s) }
    func event(_ payload: JSONValue) { onEvent?(Events.agentEvent, payload) }
    func appearance(_ payload: JSONValue) { onEvent?(Events.appearanceUpdated, payload) }
}

@MainActor
final class StoreTests: XCTestCase {
    let room = "a1b2c3d4e5f60718"
    let key = "00112233445566778899aabbccddeeff"
    var connections: [FakeConnection] = []
    var secure = MemoryStore()

    func makeStore() -> ComputersStore {
        var n = 0
        return ComputersStore(
            store: secure,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                c.replies = self.computerReplies()
                self.connections.append(c)
                return c
            },
            deviceName: { "Philip’s iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01)
    }

    func computerReplies() -> [String: ([JSONValue]) throws -> JSONValue] {
        [
            Channels.sessionsSummaries: { _ in [["id": "s1", "title": "Fix it", "updatedAt": 5], ["id": "sub", "title": "x", "updatedAt": 9, "parentSessionId": "s1"]] },
            Channels.providersList: { _ in [["id": "p", "kind": "openai", "label": "P", "enabled": true, "apiKey": "sk-x"], ["id": "off", "label": "Off", "enabled": false]] },
            Channels.settingsGet: { _ in ["defaultProviderId": "p", "defaultModelId": "m", "theme": "dark", "defaultChatMode": "ask"] },
            Channels.workspaceList: { _ in [["id": "w", "name": "App"]] },
            Channels.appInfo: { _ in ["version": "0.9.0", "platform": "darwin"] },
            Channels.chatPending: { _ in ["s1": ["question": ["callId": "q", "questions": []]]] },
            Channels.modelsList: { args in args.first == "p" ? [["id": "m", "providerId": "p", "name": "Model M"]] : [] },
        ]
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testPairsConnectsDropsTheCodeAndReadsTheComputer() async throws {
        let s = makeStore()
        s.load()
        XCTAssertTrue(s.ready)
        XCTAssertNil(s.activeId)
        let id = await s.pair(PairingLink(relayUrl: "ws://studio.tail1.ts.net:4400", room: room, key: key, pair: "ABCD2345"))
        XCTAssertEqual(id, "id-1")
        let c = try XCTUnwrap(connections.last)
        XCTAssertEqual(c.config.pairCode, "ABCD2345")
        XCTAssertEqual(c.config.deviceName, "Philip’s iPhone")
        XCTAssertEqual(c.config.platform, "ios")
        XCTAssertEqual(c.config.keyBytes, Data(repeating: 7, count: 32))
        XCTAssertTrue(c.connected)
        XCTAssertEqual(s.conn, .connecting)
        // Secrets only in the secure store, and not in the index.
        XCTAssertFalse(secure.get(ComputersStore.indexKey)!.contains(key))
        XCTAssertTrue(secure.get(ComputersStore.secretKey(id))!.contains("ABCD2345"))

        c.online()
        await settle()
        XCTAssertEqual(s.conn, .online)
        XCTAssertFalse(secure.get(ComputersStore.secretKey(id))!.contains("ABCD2345"), "the spent code is forgotten")
        XCTAssertEqual(s.summaries.map(\.id), ["s1"])
        XCTAssertEqual(s.providers.map(\.id), ["p", "off"])
        XCTAssertEqual(s.defaults.defaultModelId, "m")
        XCTAssertEqual(s.appearance?.theme, .dark)
        XCTAssertEqual(s.pcSettings.effectiveMode, .ask)
        XCTAssertEqual(s.workspaces.map(\.name), ["App"])
        XCTAssertEqual(s.activity["s1"], .needsYou)
        XCTAssertEqual(s.active?.name, "Mac", "named after its OS on first contact")
        XCTAssertEqual(s.hostVersion, "0.9.0")
        XCTAssertEqual(s.active?.route, .tailscale)

        // A reconnect after relaunch uses the stored pairing without the code.
        let s2 = makeStore()
        s2.load()
        XCTAssertEqual(s2.activeId, id)
        XCTAssertNil(connections.last?.config.pairCode)
        XCTAssertEqual(connections.last?.config.deviceId, c.config.deviceId, "same device id")
    }

    func testVersionPushKindsDismissalsAndTheTestNotification() async throws {
        let s = makeStore()
        s.load()
        _ = await s.pair(PairingLink(relayUrl: "wss://relay.example", room: room, key: key, pair: nil))
        let c = try XCTUnwrap(connections.last)
        XCTAssertEqual(s.protocolCheck, .same, "unknown until welcomed")
        c.welcomeProtocol = 1
        s.setPushToken("abcdef0123456789abcdef")
        c.online()
        await settle()
        XCTAssertEqual(s.hostProtocol, 1)
        XCTAssertEqual(s.protocolCheck, .updateComputer)
        // Registered on connect, with every kind until the phone picks.
        XCTAssertEqual(c.pushKinds.last, .some(nil))
        s.pushKinds = [.needsYou, .failed]
        await settle()
        XCTAssertEqual(c.pushKinds.last, ["needs-you", "failed"])

        // The relay's own frames.
        var dismissed: [String] = []
        s.onDismiss = { dismissed.append($0) }
        c.control(.pushRegistered(delivers: true))
        c.control(.dismiss(tag: E2E.activityTag("s1")))
        await settle()
        XCTAssertEqual(s.relayDelivers, true)
        XCTAssertEqual(dismissed, [E2E.activityTag("s1")])

        // The computer answers push:test and the relay can push: the relay path.
        c.replies[Channels.pushTest] = { _ in ["ok": true] }
        let viaRelay = try await s.sendTestNotification()
        XCTAssertEqual(viaRelay, .relay)
        XCTAssertEqual(c.callsTo(Channels.pushTest).count, 1)
        c.control(.pushRegistered(delivers: false))
        await settle()
        let local = try await s.sendTestNotification()
        XCTAssertEqual(local, .local(.relayCannotPush))
        // An older computer refuses the channel: still a notification, shown by the app.
        c.replies[Channels.pushTest] = { _ in throw RelayError("Not allowed from a paired phone (channel-denied): push:test") }
        let old = try await s.sendTestNotification()
        XCTAssertEqual(old, .local(.computerTooOld))
        // Anything else is an error the screen shows.
        c.replies[Channels.pushTest] = { _ in throw RelayError("push:test: timed out") }
        do {
            _ = try await s.sendTestNotification()
            XCTFail("should throw")
        } catch {}

        // Another computer: nothing is known about it yet.
        s.disconnect()
        s.connect(s.activeId!)
        XCTAssertNil(s.hostProtocol)
        XCTAssertNil(s.relayDelivers)
    }

    func testRepairingAKnownComputerKeepsItsIdAndName() async {
        let s = makeStore()
        s.load()
        let id = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, pair: "AAAA2222"))
        s.rename(id, to: "  Studio  ")
        let again = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, pair: "BBBB3333"))
        XCTAssertEqual(again, id)
        XCTAssertEqual(s.computers.map(\.name), ["Studio"])
    }

    func testEventsTrackActivityAppearanceAndRefreshTheList() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        var seen: [AgentEvent] = []
        let sub = s.subscribe { seen.append($0) }
        let before = c.callsTo(Channels.sessionsSummaries).count
        c.event(["type": "text", "sessionId": "s2", "delta": "hi"])
        await settle()
        XCTAssertEqual(s.activity["s2"], .running)
        c.event(["type": "done", "sessionId": "s2"])
        c.appearance(["theme": "light", "accent": "#112233"])
        await settle()
        XCTAssertNil(s.activity["s2"])
        XCTAssertEqual(s.appearance, Appearance(theme: .light, accent: 0x112233))
        XCTAssertEqual(seen.count, 2)
        XCTAssertGreaterThan(c.callsTo(Channels.sessionsSummaries).count, before, "a finished turn re-reads the list")
        s.unsubscribe(sub)
    }

    func testSummaryInvalidationsDuringPendingCallReadFinalWatchCount() async throws {
        let s = makeStore()
        await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.online()
        await settle()
        var pending: CheckedContinuation<JSONValue, Error>?
        var requests = 0
        c.summariesReply = {
            requests += 1
            if requests == 1 {
                return try await withCheckedThrowingContinuation { pending = $0 }
            }
            return [["id": "s1", "activeWatchCount": 0]]
        }
        c.event(["type": "session_meta", "sessionId": "s1"])
        c.event(["type": "done", "sessionId": "s1"])
        await settle()
        XCTAssertEqual(requests, 1, "debounce notifications coalesce")
        XCTAssertNotNil(pending)
        c.event(["type": "session_meta", "sessionId": "s1"])
        c.event(["type": "done", "sessionId": "s1"])
        await settle()
        pending?.resume(returning: [["id": "s1", "activeWatchCount": 1]])
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(s.summaries.first?.activeWatchCount, 1)
        await settle()
        XCTAssertEqual(s.summaries.first?.activeWatchCount, 0)
        XCTAssertEqual(requests, 2)
        await settle()
        XCTAssertEqual(requests, 2)
        s.disconnect()
    }

    func testSummaryReconnectDiscardsPendingReplyAndDirtyRetry() async throws {
        let s = makeStore()
        let id = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let old = try XCTUnwrap(connections.last)
        old.online()
        await settle()
        var pending: CheckedContinuation<JSONValue, Error>?
        var requests = 0
        old.summariesReply = {
            requests += 1
            return try await withCheckedThrowingContinuation { pending = $0 }
        }
        old.event(["type": "done", "sessionId": "s1"])
        await settle()
        old.event(["type": "session_meta", "sessionId": "s1"])
        await settle()
        s.connect(id)
        let fresh = try XCTUnwrap(connections.last)
        fresh.online()
        await settle()
        var freshPending: CheckedContinuation<JSONValue, Error>?
        var freshRequests = 0
        fresh.summariesReply = {
            freshRequests += 1
            if freshRequests == 1 {
                return try await withCheckedThrowingContinuation { freshPending = $0 }
            }
            return [["id": "s1", "activeWatchCount": 0]]
        }
        fresh.event(["type": "done", "sessionId": "s1"])
        await settle()
        pending?.resume(returning: [["id": "s1", "activeWatchCount": 99]])
        await settle()
        XCTAssertEqual(requests, 1)
        XCTAssertEqual(s.summaries.first?.activeWatchCount, 0)
        fresh.event(["type": "session_meta", "sessionId": "s1"])
        await settle()
        XCTAssertEqual(freshRequests, 1, "old cleanup must not clear the new task")
        freshPending?.resume(throwing: RelayError("failed"))
        await settle()
        XCTAssertEqual(freshRequests, 2, "a pending invalidation survives failure")
        fresh.summariesReply = { freshRequests += 1; throw RelayError("failed") }
        fresh.event(["type": "done", "sessionId": "s1"])
        await settle()
        await settle()
        XCTAssertEqual(freshRequests, 3, "failure alone must not loop")
        s.disconnect()
    }

    /// A pairing saved by an older app predates the derived relay credential (decision 0036):
    /// the computer has replaced its secret, so the phone asks for a fresh QR instead of dialing.
    func testAPairingFromBeforeDerivedRelayCredentialsAsksToPairAgain() async throws {
        let s = makeStore()
        s.load()
        let id = await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let saved = try XCTUnwrap(secure.get(ComputersStore.secretKey(id)))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(saved.utf8)) as? [String: Any])
        XCTAssertEqual(object["v"] as? Int, E2E.pairingVersion)
        object.removeValue(forKey: "v")
        secure.set(ComputersStore.secretKey(id), String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self))

        let before = connections.count
        let again = makeStore()
        again.load()
        await settle()
        XCTAssertEqual(connections.count, before, "no connection on the old pairing")
        XCTAssertEqual(again.conn, .denied)
        XCTAssertEqual(again.denied, .badKey)
    }

    func testDenialAndForget() async throws {
        let s = makeStore()
        s.load()
        let a = await s.pair(PairingLink(relayUrl: "wss://a", room: room, key: key))
        let b = await s.pair(PairingLink(relayUrl: "wss://b", room: "ffffffff", key: key))
        XCTAssertEqual(s.activeId, b)
        connections.last!.status(RelayStatus(.denied, detail: "revoked", denied: .revoked))
        await settle()
        XCTAssertEqual(s.denied, .revoked)
        s.forget(b)
        XCTAssertTrue(connections[connections.count - 2].closed)
        XCTAssertEqual(s.activeId, a)
        XCTAssertNil(s.denied)
        XCTAssertNil(secure.get(ComputersStore.secretKey(b)))
        s.forget(a)
        XCTAssertNil(s.activeId)
        XCTAssertTrue(s.computers.isEmpty)
    }

    /// The computer left behind must not start a second card on this phone.
    func testSwitchingComputersTellsTheOldOneToStopTheCard() async throws {
        let s = makeStore()
        s.load()
        _ = await s.pair(PairingLink(relayUrl: "wss://a", room: room, key: key))
        let first = try XCTUnwrap(connections.last)
        first.online()
        s.cardLevel = .standard
        await settle()
        XCTAssertEqual(first.cards.last?.str("level"), "standard")
        _ = await s.pair(PairingLink(relayUrl: "wss://b", room: "ffffffff", key: key))
        XCTAssertFalse(connections.last === first, "the switch did not wait")
        await settle()
        XCTAssertEqual(first.cards.last?.str("level"), "none")
        XCTAssertEqual(first.callsTo(Channels.cardSet).last, [["level": "none"]])
        XCTAssertTrue(first.closed, "closed once it has said so")
    }

    func testTheConnectionLogFollowsTheActiveComputer() async throws {
        let s = makeStore()
        s.load()
        let a = await s.pair(PairingLink(relayUrl: "wss://a", room: room, key: key))
        connections.last!.status(RelayStatus(.connecting, detail: "handshake timed out"))
        connections.last!.status(RelayStatus(.connecting, detail: "handshake timed out"))
        connections.last!.status(RelayStatus(.online))
        await settle()
        XCTAssertEqual(s.connectionLog.entries.map(\.state), [.connecting, .connecting, .online])
        XCTAssertEqual(s.connectionLog.entries[1].repeats, 2)
        s.connect(a)
        XCTAssertEqual(s.connectionLog.entries.count, 4, "reconnecting the same computer keeps its history")
        _ = await s.pair(PairingLink(relayUrl: "wss://b", room: "ffffffff", key: key))
        XCTAssertEqual(s.connectionLog.entries.map(\.state), [.connecting], "another computer starts its own")
        XCTAssertFalse(s.connectionLog.text(relayHost: "b", route: .internet).contains(room))
    }

    func testChatOperationsCallTheComputerWithPhoneKeysOnly() async throws {
        let s = makeStore()
        s.load()
        await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key))
        let c = try XCTUnwrap(connections.last)
        c.replies[Channels.sessionCreate] = { _ in ["id": "new", "title": ""] }
        c.replies[Channels.settingsUpdate] = { _ in ["defaultChatMode": "yolo"] }
        c.online()
        await settle()
        try await s.completeChat("s1")
        XCTAssertEqual(s.summaries.first?.archived, true)
        XCTAssertEqual(c.callsTo(Channels.sessionSetOptions).last, ["s1", ["archivedAt": 1000]])
        try await s.restoreChat("s1")
        XCTAssertEqual(s.summaries.first?.archived, false)
        try await s.renameChat("s1", to: " New name ")
        XCTAssertEqual(s.summaries.first?.title, "New name")
        let id = try await s.createChat(providerId: "p", modelId: "m", workspaceId: "w", mode: .guardrails, effort: .high)
        XCTAssertEqual(id, "new")
        XCTAssertEqual(c.callsTo(Channels.sessionCreate).last, ["w"])
        XCTAssertEqual(c.callsTo(Channels.sessionSetOptions).last, ["new", ["providerId": "p", "modelId": "m", "mode": "guardrails", "effort": "high"]])
        try await s.updatePcSettings(PcSettings.patch(mode: .yolo))
        XCTAssertEqual(s.pcSettings.effectiveMode, .yolo)
        try await s.deleteChat("s1")
        XCTAssertTrue(s.summaries.isEmpty)
        await s.loadAllModels()
        XCTAssertEqual(s.modelGroups.map(\.provider.id), ["p"], "only enabled providers")
        XCTAssertEqual(s.modelGroups.first?.models?.map(\.name), ["Model M"])
        s.setPushToken("apns-token")
        await settle()
        XCTAssertEqual(c.pushTokens.last, "apns-token")
        // The Live Activity card: its tokens and level go to the relay, the level to the computer.
        s.cardLevel = .standard
        s.cardStartToken = "cd34"
        s.cardToken = "ab12"
        await settle()
        let name = try XCTUnwrap(s.active?.name)
        XCTAssertEqual(c.cards.last, ["token": "ab12", "startToken": "cd34", "level": "standard", "computerId": .string(s.activeId ?? ""),
                                      "computerName": .string(name)])
        XCTAssertEqual(c.callsTo(Channels.cardSet).last, [["level": "standard"]])
        await s.cardAction(focus: "s1")
        await s.cardAction(dismiss: "s2")
        XCTAssertEqual(c.callsTo(Channels.cardSet).suffix(2), [[["focus": "s1"]], [["dismiss": "s2"]]])
        let before = (c.cards.count, c.callsTo(Channels.cardSet).count)
        s.cardToken = "ab12"
        await settle()
        XCTAssertEqual(c.cards.count, before.0, "nothing changed: not sent again")
        // Every connect registers again (a relay restart forgets).
        c.online()
        await settle()
        XCTAssertEqual(c.cards.count, before.0 + 1)
        XCTAssertEqual(c.callsTo(Channels.cardSet).count, before.1 + 1)
    }
}

@MainActor
final class ChatModelTests: XCTestCase {
    func makeOnline() async throws -> (ComputersStore, FakeConnection) {
        var conns: [FakeConnection] = []
        let s = ComputersStore(store: MemoryStore(), makeConnection: { cfg in
            let c = FakeConnection(config: cfg)
            c.replies = [
                Channels.settingsGet: { _ in ["defaultProviderId": "p", "defaultModelId": "m"] },
                Channels.sessionGet: { _ in ["id": "s", "title": "T", "messages": [["id": "u", "role": "user", "content": "earlier"]], "queue": []] },
                Channels.chatPending: { _ in [:] },
                Channels.skillsRunnable: { _ in [["name": "review", "description": "Review", "template": "SECRET"]] },
            ]
            conns.append(c)
            return c
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) })
        s.load()
        await s.pair(PairingLink(relayUrl: "wss://r", room: "a1b2c3d4e5f60718", key: "00112233445566778899aabbccddeeff"))
        conns[0].online()
        for _ in 0..<50 { await Task.yield() }
        try await Task.sleep(nanoseconds: 30_000_000)
        return (s, conns[0])
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testStreamsATurnAndReReadsWhenItEnds() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s, now: { 42 })
        chat.start()
        await settle()
        XCTAssertEqual(chat.title, "T")
        XCTAssertEqual(chat.skills.map(\.name), ["review"])
        XCTAssertNil(chat.blocked)
        let sent = try await chat.send("go", skill: SkillSummary(name: "review"))
        XCTAssertTrue(chat.turn.running)
        // The computer lists the prompt's id once it has it, which takes it out of the outbox.
        c.replies[Channels.sessionGet] = { _ in
            ["id": "s", "title": "T", "messages": [["id": "u", "role": "user", "content": "earlier"]], "queue": [], "clientMessageIds": [.string(sent)]]
        }
        await settle()
        let send = try XCTUnwrap(c.callsTo(Channels.chatSend).last?.first)
        XCTAssertEqual(send["skill"], ["name": "review", "input": "go"])
        XCTAssertEqual(send.str("modelId"), "m")

        c.event(["type": "text", "sessionId": "s", "delta": "Hi"])
        c.event(["type": "text", "sessionId": "other", "delta": "not mine"])
        await settle()
        XCTAssertEqual(chat.blocks.map(\.id), ["u", "pending-42", "live-42-1"])

        // Mid-run prompts queue instead of starting a turn.
        c.replies[Channels.chatQueue] = { _ in ["id": "s", "title": "T", "messages": [], "queue": ["later"]] }
        try await chat.send("later")
        XCTAssertEqual(chat.queued, ["later"])

        c.replies[Channels.sessionGet] = { _ in
            ["id": "s", "title": "T", "messages": [["id": "u", "role": "user", "content": "earlier"], ["id": "u2", "role": "user", "content": "/review go"],
                                                  ["id": "a2", "role": "assistant", "content": "Hi"]], "queue": []]
        }
        c.event(["type": "done", "sessionId": "s"])
        await settle()
        XCTAssertFalse(chat.turn.running)
        // The saved prompt and reply keep the ids they were shown under, so their rows aren't rebuilt.
        XCTAssertEqual(chat.blocks.map(\.id), ["u", "pending-42", "live-42-1"])
        XCTAssertEqual(chat.blocks.map { if case .assistant(_, let t, _, _, _) = $0 { return t } else { return nil } }.compactMap { $0 }, ["Hi"])
        chat.stop()
    }

    /// A Send tapped just as a reply finishes goes as a new turn: the re-read that
    /// still says "running" is stale until the debounced reload after `done`.
    func testASendRightAfterDoneStartsATurnNotAQueue() async throws {
        let (s, c) = try await makeOnline()
        c.replies[Channels.sessionGet] = { _ in ["id": "s", "title": "T", "messages": [], "queue": [], "activeRun": ["startedAt": 1]] }
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settle()
        c.event(["type": "text", "sessionId": "s", "delta": "Hi"])
        c.event(["type": "done", "sessionId": "s"])
        for _ in 0..<20 { await Task.yield() }
        c.replies[Channels.sessionGet] = { _ in ["id": "s", "title": "T", "messages": [], "queue": []] }
        try await chat.send("next")
        await settle()
        XCTAssertEqual(c.callsTo(Channels.chatSend).first?.first?.str("text"), "next", "a new turn")
        XCTAssertTrue(c.callsTo(Channels.chatQueue).isEmpty, "an idle chat's queue never runs")
        chat.stop()
    }

    func testApprovalsQuestionsAndStop() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settle()
        c.event(["type": "tool_approval_required", "sessionId": "s", "call": ["id": "t", "name": "bash", "input": ["command": "rm x"]], "reason": "r", "severity": "high"])
        await settle()
        XCTAssertEqual(chat.turn.approval?.severity, .high)
        try await chat.approve(true)
        XCTAssertNil(chat.turn.approval)
        XCTAssertEqual(c.callsTo(Channels.toolApprove).last, ["s", "t", true])

        c.event(["type": "question", "sessionId": "s", "request": ["callId": "q", "questions": [["id": "x", "question": "Which?", "options": [["label": "A"]]]]]])
        await settle()
        XCTAssertEqual(chat.turn.question?.callId, "q")
        try await chat.answer([AskAnswer(questionId: "x", labels: ["A"])])
        XCTAssertEqual(c.callsTo(Channels.chatAnswer).last, ["s", "q", [["questionId": "x", "labels": ["A"]]]])
        chat.abort()
        await settle()
        XCTAssertEqual(c.callsTo(Channels.chatAbort).last, ["s"])
    }

    func testAReReadInFlightKeepsACardThatArrivedMeanwhile() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settle()
        // The computer answers "nothing pending" from before the approval, and the
        // approval's event reaches the phone before that answer does.
        c.replies[Channels.chatPending] = { _ in
            c.event(["type": "tool_approval_required", "sessionId": "s", "call": ["id": "t", "name": "bash", "input": ["command": "rm x"]], "reason": "r", "severity": "high"])
            Thread.sleep(forTimeInterval: 0.3)
            return [:]
        }
        await chat.reload()
        XCTAssertEqual(chat.turn.approval?.call.id, "t", "the computer still waits on it, so the card stays")
        // With no events in flight the re-read is the authority: an approval answered elsewhere goes.
        c.replies[Channels.chatPending] = { _ in [:] }
        await chat.reload()
        XCTAssertNil(chat.turn.approval)

        // The other way round: a re-read from before an answer doesn't bring the answered card back.
        c.event(["type": "question", "sessionId": "s", "request": ["callId": "q", "questions": [["id": "x", "question": "Which?", "options": [["label": "A"]]]]]])
        await settle()
        c.replies[Channels.chatPending] = { _ in
            Thread.sleep(forTimeInterval: 0.3)
            return ["s": ["question": ["callId": "q", "questions": [["id": "x", "question": "Which?", "options": [["label": "A"]]]]]]]
        }
        async let stale: Void = chat.reload()
        try await Task.sleep(nanoseconds: 100_000_000)
        try await chat.answer([AskAnswer(questionId: "x", labels: ["A"])])
        await stale
        XCTAssertNil(chat.turn.question, "answered, so the card stays down")
        chat.stop()
    }

    func testAFailedAnswerKeepsTheCardSoItCanBeRetried() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settle()
        c.event(["type": "tool_approval_required", "sessionId": "s", "call": ["id": "t", "name": "bash", "input": ["command": "rm x"]], "reason": "r", "severity": "high"])
        await settle()
        c.replies[Channels.toolApprove] = { _ in throw RelayError("offline") }
        do { try await chat.approve(true); XCTFail("expected a failure") } catch {}
        XCTAssertEqual(chat.turn.approval?.call.id, "t", "the computer is still waiting, so the card stays")

        c.event(["type": "question", "sessionId": "s", "request": ["callId": "q", "questions": [["id": "x", "question": "Which?", "options": [["label": "A"]]]]]])
        await settle()
        c.replies[Channels.chatAnswer] = { _ in throw RelayError("offline") }
        do { try await chat.answer([AskAnswer(questionId: "x", labels: ["A"])]); XCTFail("expected a failure") } catch {}
        XCTAssertEqual(chat.turn.question?.callId, "q")
        chat.stop()
    }

    func testAPromptThatNeverStartedComesBackToTheComposer() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s, now: { 7 })
        chat.start()
        await settle()
        // The computer answered with a refusal (not a dropped connection, which goes to the outbox).
        c.replies[Channels.chatSend] = { _ in throw RelayError("The computer went offline.", fromComputer: true) }
        try await chat.send("draft", skill: SkillSummary(name: "review"), images: ["data:image/jpeg;base64,AA"])
        XCTAssertTrue(chat.running)
        await settle()
        XCTAssertFalse(chat.running)
        XCTAssertEqual(chat.error, "The computer went offline.")
        XCTAssertFalse(chat.blocks.contains { $0.id == "pending-7" }, "no bubble for a prompt that was never delivered")
        let back = try XCTUnwrap(chat.takeUnsent())
        XCTAssertEqual(back.text, "draft")
        XCTAssertEqual(back.skill?.name, "review")
        XCTAssertEqual(back.images.count, 1)
        XCTAssertNil(chat.takeUnsent(), "handed back once")
        chat.stop()
    }

    func testBlockedReasons() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        c.status(RelayStatus(.offline))
        await settle()
        // Offline is not a reason to block: Send puts the prompt in the outbox.
        XCTAssertNil(chat.blocked)
        XCTAssertTrue(chat.sendsLater)
        XCTAssertEqual(chat.offlineNote, "\(s.active!.name) is offline. What you send waits on this iPhone and goes when it’s back.")
        c.status(RelayStatus(.denied, denied: .revoked))
        await settle()
        XCTAssertEqual(chat.blocked, "This phone is no longer paired.")
        XCTAssertEqual(ChatModel.resolveModel(nil, RemoteDefaults()).1, nil)
    }
}
