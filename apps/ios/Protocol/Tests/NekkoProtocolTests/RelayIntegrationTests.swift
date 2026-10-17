import Foundation
import XCTest
@testable import NekkoProtocol

/// The Swift relay client against the real thing: the relay (apps/relay/dist),
/// a headless agent (apps/server/dist in relay-agent mode) and a fake
/// OpenAI-compatible model, over the real `URLSessionTransport`. The same
/// journey as Android's `RelayIntegrationTest.kt`: enrollment with the
/// one-time code, provider keys stripped, a streamed turn, a guarded tool call
/// denied from the phone, a skill turn, reconnecting without a code, and the
/// spent code refused.
///
/// Opt-in: `apps/ios/scripts/itest.sh` starts the three processes and passes
/// their coordinates in `NEKKO_ITEST_*`; without them every test is skipped.
final class RelayIntegrationTests: XCTestCase {
    struct Env {
        let relay, room, key, pair: String
        let keyBytes: Data
    }

    static let env: Env? = {
        let e = ProcessInfo.processInfo.environment
        guard let relay = e["NEKKO_ITEST_RELAY"], let room = e["NEKKO_ITEST_ROOM"], let key = e["NEKKO_ITEST_KEY"],
              let pair = e["NEKKO_ITEST_PAIR"] else { return nil }
        return Env(relay: relay, room: room, key: key, pair: pair, keyBytes: E2E.deriveKey(secret: key, room: room))
    }()

    func client(_ env: Env, pair: String?, deviceId: String = UUID().uuidString.lowercased()) -> (RelayClient, RelayClientTests.Recorder) {
        var cfg = RelayConfig(relayUrl: env.relay, room: env.room, key: env.key, keyBytes: env.keyBytes, deviceId: deviceId,
                              deviceName: "iOS itest", pairCode: pair)
        cfg.requestTimeout = 30
        #if os(Linux)
        let transport: WsTransport = SocketTransport() // libcurl there has no WebSockets
        #else
        let transport: WsTransport = URLSessionTransport()
        #endif
        let c = RelayClient(config: cfg, transport: transport)
        let r = RelayClientTests.Recorder()
        r.attach(c)
        return (c, r)
    }

    /// Events for one session from the recorder, from `start` on.
    func events(_ r: RelayClientTests.Recorder, session: String, from start: Int = 0) -> [AgentEvent] {
        r.lock.sync { Array(r.events.dropFirst(start)) }
            .filter { $0.0 == Events.agentEvent }.compactMap { AgentEvent.from($0.1) }.filter { $0.sessionId == session }
    }

    func waitFor(_ timeout: TimeInterval, _ what: String, _ cond: @escaping () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if cond() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    func testA_RefusesAStrangerWithoutACode() async throws {
        guard let env = Self.env else { throw XCTSkip("set NEKKO_ITEST_* (apps/ios/scripts/itest.sh)") }
        let (c, r) = client(env, pair: nil)
        c.connect()
        let s = await r.await(.denied)
        XCTAssertTrue([.unknownDevice, .kicked].contains(s?.denied))
        c.close()
    }

    func testB_EnrollsDrivesTheHostStreamsATurnAndDeniesATool() async throws {
        guard let env = Self.env else { throw XCTSkip("set NEKKO_ITEST_* (apps/ios/scripts/itest.sh)") }
        let deviceId = UUID().uuidString.lowercased()
        let (c, r) = client(env, pair: env.pair, deviceId: deviceId)
        c.connect()
        await r.await(.online)

        let rawInfo = try await c.call(Channels.appInfo)
        let info = AppInfo.from(rawInfo)
        XCTAssertFalse((info.version ?? "").isEmpty)
        let rawProviders = try await c.call(Channels.providersList)
        XCTAssertTrue(PublicProvider.list(rawProviders).contains(PublicProvider(id: "fake", kind: "openai-compat", label: "Fake", enabled: true)))
        XCTAssertFalse(rawProviders.serialized().contains("sk-should-never"), "the computer strips provider keys")
        let rawSettings = try await c.call(Channels.settingsGet)
        XCTAssertEqual(RemoteDefaults.from(rawSettings), RemoteDefaults(defaultProviderId: "fake", defaultModelId: "fake-model"))
        print("itest: enrolled as \(deviceId.prefix(8)), host \(info.version ?? "?")")

        // 1. A plain streamed turn.
        let created = try await c.call(Channels.sessionCreate)
        let session = try XCTUnwrap(Session.from(created))
        _ = try await c.call(Channels.chatSend, [sendOptions(sessionId: session.id, providerId: "fake", modelId: "fake-model", text: "Say hello")], timeout: 60)
        await waitFor(10, "done") { self.events(r, session: session.id).contains { if case .done = $0 { return true } else { return false } } }
        let mine = events(r, session: session.id)
        let text = mine.compactMap { if case .text(_, let d) = $0 { return d } else { return nil } }.joined()
        XCTAssertEqual(text, "Hello from your computer.")
        let turn = mine.reduce(LiveTurn(running: true)) { Transcript.apply($0, $1) }
        XCTAssertFalse(turn.running)
        let rawSaved = try await c.call(Channels.sessionGet, [.string(session.id)])
        let saved = try XCTUnwrap(Session.from(rawSaved))
        XCTAssertEqual(saved.messages.map(\.role), ["user", "assistant"])
        guard case .assistant(_, let reply, _, _, _)? = Transcript.fromMessages(saved.messages).last else { return XCTFail("no reply") }
        XCTAssertEqual(reply, "Hello from your computer.")
        let summaries = try await c.call(Channels.sessionsSummaries)
        XCTAssertTrue(SessionSummary.visible(summaries).contains { $0.id == session.id })
        print("itest: streamed \(mine.count) events into \(session.id)")

        // 2. A guarded tool call: the phone sees the approval, denies it, and the turn ends.
        let created2 = try await c.call(Channels.sessionCreate)
        let s2 = try XCTUnwrap(Session.from(created2))
        let mark = r.lock.sync { r.events.count }
        let send = Task { try? await c.call(Channels.chatSend, [sendOptions(sessionId: s2.id, providerId: "fake", modelId: "fake-model", text: "please approve a cleanup")], timeout: 60) }
        var approval: Approval?
        await waitFor(30, "approval") {
            approval = self.events(r, session: s2.id, from: mark).lazy.compactMap { if case .approvalRequired(_, let a) = $0 { return a } else { return nil } }.first
            return approval != nil
        }
        let a = try XCTUnwrap(approval)
        XCTAssertEqual(a.call.name, "bash")
        XCTAssertEqual(a.call.input["command"]?.string, "rm -rf ./nekko-itest-dist")
        let pending = PendingInput.map(try await c.call(Channels.chatPending))
        XCTAssertEqual(pending[s2.id]?.approval?.call.id, a.call.id)
        _ = try await c.call(Channels.toolApprove, [.string(s2.id), .string(a.call.id), false])
        await waitFor(60, "turn end") { self.events(r, session: s2.id, from: mark).contains(where: \.endsTurn) }
        _ = await send.value
        let rawAfter = try await c.call(Channels.sessionGet, [.string(s2.id)])
        let afterDeny = try XCTUnwrap(Session.from(rawAfter))
        let tools = Transcript.fromMessages(afterDeny.messages).filter { if case .tool = $0 { return true } else { return false } }
        XCTAssertEqual(tools.map(\.id), [a.call.id])
        let pendingAfter = try await c.call(Channels.chatPending)
        XCTAssertNil(PendingInput.map(pendingAfter)[s2.id]?.approval)
        print("itest: approval for `\(a.call.input["command"]?.string ?? "")` (\(a.severity)) denied from the phone")

        // 2b. The agent asks a question; the phone answers it and the turn carries on.
        let createdQ = try await c.call(Channels.sessionCreate)
        let sq = try XCTUnwrap(Session.from(createdQ))
        let markQ = r.lock.sync { r.events.count }
        let sendQ = Task { try? await c.call(Channels.chatSend, [sendOptions(sessionId: sq.id, providerId: "fake", modelId: "fake-model", text: "ask me which platform")], timeout: 60) }
        var asked: AskRequest?
        await waitFor(30, "question") {
            asked = self.events(r, session: sq.id, from: markQ).lazy.compactMap { if case .question(_, let q) = $0 { return q } else { return nil } }.first
            return asked != nil
        }
        let q = try XCTUnwrap(asked)
        XCTAssertEqual(q.questions.first?.options.map(\.label), ["iOS", "Android"])
        _ = try await c.call(Channels.chatAnswer, [.string(sq.id), .string(q.callId), .array([AskAnswer(questionId: q.questions[0].id, labels: ["iOS"]).json])])
        await waitFor(60, "turn end after the answer") { self.events(r, session: sq.id, from: markQ).contains(where: \.endsTurn) }
        _ = await sendQ.value
        let replyQ = self.events(r, session: sq.id, from: markQ).compactMap { if case .text(_, let d) = $0 { return d } else { return nil } }.joined()
        XCTAssertEqual(replyQ, "Hello from your computer.")
        print("itest: question answered from the phone (\(q.questions.count) question)")

        // 2c. The agent writes a file; the phone reads the change, read only.
        let createdW = try await c.call(Channels.sessionCreate)
        let sw = try XCTUnwrap(Session.from(createdW))
        let markW = r.lock.sync { r.events.count }
        _ = try await c.call(Channels.chatSend, [sendOptions(sessionId: sw.id, providerId: "fake", modelId: "fake-model", text: "write a note")], timeout: 60)
        await waitFor(60, "turn end after the write") { self.events(r, session: sw.id, from: markW).contains(where: \.endsTurn) }
        let rawPc = try await c.call(Channels.settingsGet)
        XCTAssertTrue(PcSettings.from(rawPc).phoneChanges)
        let rawChanges = try await c.call(Channels.changesList, [.string(sw.id)])
        let changes = PhoneChanges.from(rawChanges)
        let note = try XCTUnwrap(changes.files.first { $0.path.hasSuffix("nekko-itest-note.txt") }, "changes: \(rawChanges.serialized())")
        XCTAssertTrue(note.added)
        XCTAssertEqual(note.linesAdded, 2)
        XCTAssertEqual(note.hunks.first?.lines.map(\.text), ["first line", "written by the agent"])
        XCTAssertFalse(rawChanges.serialized().contains("\"original\""), "the phone never gets whole files")
        XCTAssertLessThanOrEqual(note.path.split(separator: "/").count, 3, "the path is cut to its last parts")
        do {
            _ = try await c.call("changes:accept", [.string(sw.id), .string("nekko-itest-note.txt")])
            XCTFail("a phone accepted a change")
        } catch {
            XCTAssertTrue("\(error)".contains("Not allowed from a paired phone"), "\(error)")
        }
        print("itest: the phone read \(changes.files.count) changed file(s), and accepting from it was refused")

        // 3. Skills: names only reach the phone, and a skill turn is expanded on the computer.
        let rawSkills = try await c.call(Channels.skillsRunnable)
        let skills = SkillSummary.list(rawSkills)
        XCTAssertTrue(skills.contains { $0.source == "builtin" })
        XCTAssertFalse(rawSkills.serialized().contains("\"template\""))
        let skill = try XCTUnwrap(skills.first)
        let created3 = try await c.call(Channels.sessionCreate)
        let s3 = try XCTUnwrap(Session.from(created3))
        _ = try await c.call(Channels.chatSend, [sendOptions(sessionId: s3.id, providerId: "fake", modelId: "fake-model", text: "the README", skill: skill)], timeout: 60)
        let rawS3 = try await c.call(Channels.sessionGet, [.string(s3.id)])
        let user = try XCTUnwrap(Session.from(rawS3)?.messages.first { $0.role == "user" })
        XCTAssertEqual(user.skill?.name, skill.name)
        XCTAssertTrue(user.content.count > "the README".count && user.content.hasSuffix("the README"))
        print("itest: /\(skill.name) expanded on the computer to \(user.content.count) chars")

        // 4. Phone-side session options: rename, complete and restore.
        _ = try await c.call(Channels.sessionSetOptions, [.string(s3.id), ["title": "Renamed from iOS", "archivedAt": 1_760_000_000_000]])
        var listed = SessionSummary.visible(try await c.call(Channels.sessionsSummaries)).first { $0.id == s3.id }
        XCTAssertEqual(listed?.title, "Renamed from iOS")
        XCTAssertEqual(listed?.archived, true)
        _ = try await c.call(Channels.sessionSetOptions, [.string(s3.id), ["archivedAt": nil]])
        listed = SessionSummary.visible(try await c.call(Channels.sessionsSummaries)).first { $0.id == s3.id }
        XCTAssertEqual(listed?.archived, false)
        c.close()

        // 5. Reconnecting as the same device works without a code.
        let (again, ra) = client(env, pair: nil, deviceId: deviceId)
        again.connect()
        await ra.await(.online)
        again.close()
        print("itest: reconnected as the same device without a code")

        // 6. The one-time code is spent: another phone presenting it is refused.
        let (replay, rr) = client(env, pair: env.pair)
        replay.connect()
        let s = await rr.await(.denied)
        XCTAssertTrue([.badCode, .kicked].contains(s?.denied))
        print("itest: spent code refused (\(s?.denied?.rawValue ?? "?"))")
    }
}
