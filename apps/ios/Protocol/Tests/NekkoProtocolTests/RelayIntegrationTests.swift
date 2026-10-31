import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import NekkoProtocol

/// The Swift relay client against the real thing: the relay (apps/relay-server/dist),
/// a headless agent (apps/local-web-ui/dist in relay-agent mode) and a fake
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

    /// The phone testB enrolled, so later tests reconnect without a (single-use) code.
    static var enrolled: String?

    static let env: Env? = {
        let e = ProcessInfo.processInfo.environment
        guard let relay = e["NEKKO_ITEST_RELAY"], let room = e["NEKKO_ITEST_ROOM"], let key = e["NEKKO_ITEST_KEY"],
              let pair = e["NEKKO_ITEST_PAIR"] else { return nil }
        return Env(relay: relay, room: room, key: key, pair: pair, keyBytes: E2E.deriveKey(secret: key, room: room))
    }()

    /// One device key per test device, kept across its connections, as the Keychain keeps it.
    final class Signers: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [String: SoftwareHelloSigner] = [:]
        func signer(for id: String) -> SoftwareHelloSigner {
            lock.lock()
            defer { lock.unlock() }
            if let s = all[id] { return s }
            let s = SoftwareHelloSigner()
            all[id] = s
            return s
        }
    }
    static let signers = Signers()

    func client(_ env: Env, pair: String?, deviceId: String = UUID().uuidString.lowercased()) -> (RelayClient, RelayClientTests.Recorder) {
        var cfg = RelayConfig(relayUrl: env.relay, room: env.room, key: env.key, keyBytes: env.keyBytes, deviceId: deviceId,
                              deviceName: "iOS itest", pairCode: pair)
        cfg.requestTimeout = 30
        cfg.helloSigner = Self.signers.signer(for: deviceId)
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
        Self.enrolled = deviceId

        let rawInfo = try await c.call(Channels.appInfo)
        let info = AppInfo.from(rawInfo)
        XCTAssertFalse((info.version ?? "").isEmpty)
        // IO-32: this computer speaks the phone's protocol version.
        XCTAssertEqual(r.lock.sync { r.welcomes.last?.protocolVersion }, PhoneProtocol.version)
        // IO-30: the test stack's relay has no Apple push key and says so; the
        // computer answers push:test itself.
        let control = RelayClientTests.Seen()
        c.setControlHandler { control.add($0) }
        try await c.registerPush(token: String(repeating: "ab", count: 32), kinds: ["needs-you"])
        await waitFor(5, "push-registered") { !control.all.isEmpty }
        XCTAssertEqual(control.all.first, .pushRegistered(delivers: false))
        let tested = try await c.call(Channels.pushTest)
        XCTAssertEqual(tested["ok"], .bool(true))
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

    /// Exactly-once delivery (IO-18 OF-3, OF-8): the relay dies while a prompt
    /// is in flight, comes back, and the phone sends the prompt again with the
    /// same `clientMessageId`, as its outbox does. The computer keeps one user
    /// message per id, whether the first copy arrived or not.
    func testC_DeliversExactlyOnceWhenTheRelayDiesMidSend() async throws {
        guard let env = Self.env else { throw XCTSkip("set NEKKO_ITEST_* (apps/ios/scripts/itest.sh)") }
        guard let ctl = ProcessInfo.processInfo.environment["NEKKO_ITEST_RELAY_CTL"] else { throw XCTSkip("set NEKKO_ITEST_RELAY_CTL") }
        guard let device = Self.enrolled else { throw XCTSkip("needs testB's enrolled phone") }
        let (c, r) = client(env, pair: nil, deviceId: device)
        c.connect()
        await r.await(.online)
        let created = try await c.call(Channels.sessionCreate)
        let chat = try XCTUnwrap(Session.from(created))

        // 1. The computer saved the prompt (a long reply streams), then the relay dies: the answer is lost.
        let slowId = UUID().uuidString.lowercased()
        let slow = sendOptions(sessionId: chat.id, providerId: "fake", modelId: "fake-model", text: "slow, exactly once", clientMessageId: slowId)
        let mark = r.lock.sync { r.events.count }
        let first = Task { try? await c.call(Channels.chatSend, [slow], timeout: 60) }
        await waitFor(20, "the computer saved the prompt") {
            self.events(r, session: chat.id, from: mark).contains { if case .text = $0 { return true } else { return false } }
        }
        try await relay(ctl, "stop")
        _ = await first.value
        try await relay(ctl, "start")
        try await resend(c, r, slow)
        print("itest: relay killed mid-reply, prompt sent again with the same id")

        // 2. The relay dies right after the frame leaves: whether it arrived is unknown.
        let quickId = UUID().uuidString.lowercased()
        let quick = queuePrompt(text: "quick, exactly once", clientMessageId: quickId)
        let second = Task { try? await c.call(Channels.chatQueue, [.string(chat.id), quick], timeout: 30) }
        try await relay(ctl, "stop")
        _ = await second.value
        try await relay(ctl, "start")
        try await resend(c, r, quick, queueIn: chat.id)
        print("itest: relay killed as a queued prompt left, sent again with the same id")

        let raw = try await c.call(Channels.sessionGet, [.string(chat.id)])
        let saved = try XCTUnwrap(Session.from(raw))
        let users = saved.messages.filter { $0.role == "user" }.map(\.content)
        XCTAssertEqual(users.filter { $0 == "slow, exactly once" }.count, 1, "one user message for the resent prompt: \(users)")
        XCTAssertEqual(users.count + saved.queue.count, 2, "each prompt once, sent or queued: \(users) + \(saved.queue)")
        XCTAssertEqual(saved.queue.filter { $0 == "quick, exactly once" }.count + users.filter { $0 == "quick, exactly once" }.count, 1)
        XCTAssertTrue(saved.clientMessageIds.contains(slowId) && saved.clientMessageIds.contains(quickId), "\(saved.clientMessageIds)")
        print("itest: exactly one user message per prompt after two relay restarts")
        c.close()
    }

    /// IO-22 to IO-29 against the real computer: the queue edited before it
    /// runs (a stale edit refused), a fork from a prompt, saved prompts, the
    /// computer's automation run from the phone, and the read-only views
    /// (pull requests, usage, limits). Making or changing automations and raw
    /// git stay refused.
    func testD_EditsTheQueueForksAndRunsAnAutomation() async throws {
        guard let env = Self.env else { throw XCTSkip("set NEKKO_ITEST_* (apps/ios/scripts/itest.sh)") }
        guard let device = Self.enrolled else { throw XCTSkip("needs testB's enrolled phone") }
        let (c, r) = client(env, pair: nil, deviceId: device)
        c.connect()
        await r.await(.online)

        // 1. The queue: edit one prompt, refuse a stale edit, remove another.
        let created = try await c.call(Channels.sessionCreate)
        let chat = try XCTUnwrap(Session.from(created))
        _ = try await c.call(Channels.chatQueue, [.string(chat.id), "first thing"])
        _ = try await c.call(Channels.chatQueue, [.string(chat.id), "second thing"])
        let edited = try await c.call(Channels.chatEditQueued, [.string(chat.id), 0, QueuedPrompt.edit(expect: "first thing", text: "first, edited")])
        XCTAssertEqual(QueuedPrompt.list(edited["queue"]).map(\.text), ["first, edited", "second thing"])
        do {
            _ = try await c.call(Channels.chatEditQueued, [.string(chat.id), 0, QueuedPrompt.edit(expect: "first thing", text: "late")])
            XCTFail("a stale edit landed")
        } catch {
            XCTAssertTrue("\(error)".contains("already started or changed"), "\(error)")
        }
        _ = try await c.call(Channels.chatEditQueued, [.string(chat.id), 1, QueuedPrompt.edit(expect: "second thing", text: nil)])
        let rawQueue = try await c.call(Channels.sessionGet, [.string(chat.id)])
        let afterQueue = try XCTUnwrap(Session.from(rawQueue))
        XCTAssertEqual(afterQueue.queue, ["first, edited"])
        print("itest: queued prompt edited and removed from the phone; a stale edit refused")

        // 2. Fork: a turn, then a new chat that ends before its prompt.
        let createdF = try await c.call(Channels.sessionCreate)
        let sf = try XCTUnwrap(Session.from(createdF))
        _ = try await c.call(Channels.chatSend, [sendOptions(sessionId: sf.id, providerId: "fake", modelId: "fake-model", text: "Say hello")], timeout: 60)
        let rawTurned = try await c.call(Channels.sessionGet, [.string(sf.id)])
        let turned = try XCTUnwrap(Session.from(rawTurned))
        let prompt = try XCTUnwrap(turned.messages.first { $0.role == "user" })
        let fork = try await c.call(Channels.sessionFork, [.string(sf.id), .string(prompt.id)])
        let forkId = try XCTUnwrap(fork.str("id"))
        XCTAssertNotEqual(forkId, sf.id)
        XCTAssertNil(fork["messages"], "the fork's reply is its id and title only")
        let rawForked = try await c.call(Channels.sessionGet, [.string(forkId)])
        let forked = try XCTUnwrap(Session.from(rawForked))
        XCTAssertTrue(forked.messages.isEmpty, "the fork ends before the prompt")
        let whole = try await c.call(Channels.sessionFork, [.string(sf.id)])
        let rawAll = try await c.call(Channels.sessionGet, [whole["id"] ?? .null])
        let all = try XCTUnwrap(Session.from(rawAll))
        XCTAssertEqual(all.messages.map(\.role), ["user", "assistant"])
        print("itest: forked \(sf.id) before its prompt and whole")

        // 3. Saved prompts arrive with the settings, names and text only.
        let settings = PcSettings.from(try await c.call(Channels.settingsGet))
        XCTAssertEqual(settings.prompts, [SavedPrompt(id: "hello", name: "hello", body: "Say hello")])

        // 4. Automations: list, Run now, and the result comes back; editing them is refused.
        let tasks = AutomationTask.list(try await c.call(Channels.tasksList))
        let task = try XCTUnwrap(tasks.first { $0.id == "itest-task" })
        XCTAssertEqual(task.cadence, "Every day")
        let raw = try await c.call(Channels.tasksList)
        XCTAssertFalse(raw.serialized().contains("\"prompt\""), "a task's instruction stays on the computer")
        _ = try await c.call(Channels.taskRunNow, [.string("itest-task")])
        var ran: AutomationTask?
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            ran = AutomationTask.list(try await c.call(Channels.tasksList)).first { $0.id == "itest-task" }
            if (ran?.runCount ?? 0) >= 1 && ran?.lastResult != nil { break }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        XCTAssertEqual(ran?.lastResult, "Hello from your computer.", "the task ran and its answer came back")
        _ = AutomationWorkflow.list(try await c.call(Channels.workflowsList))
        for refused in ["task:create", "task:update", "task:delete", "workflow:update", "pr:action", "workspace:gitStatus"] {
            do {
                _ = try await c.call(refused, [.string("itest-task"), [:]])
                XCTFail("\(refused) was allowed from a phone")
            } catch {
                XCTAssertTrue("\(error)".contains("Not allowed from a paired phone"), "\(refused): \(error)")
            }
        }
        print("itest: ran \(task.title) from the phone: \(ran?.lastResult ?? "")")

        // 5. Read-only views: no PRs for this chat, usage, and no limits for a plain API key.
        let prs = try await c.call(Channels.prSessionList, [.string(sf.id)])
        XCTAssertEqual(PullRequest.list(prs), [])
        let usage = try await c.call(Channels.usageSummary)
        XCTAssertNotNil(UsageSummary.from(usage))
        let limits = try await c.call(Channels.limitsGet, ["fake"])
        XCTAssertNil(ProviderLimits.from(limits))
        c.close()
    }

    /// The phone gets back through (relay up, computer re-attached) and sends
    /// again with the same id, retrying while the computer is still out of reach.
    private func resend(_ c: RelayClient, _ r: RelayClientTests.Recorder, _ prompt: JSONValue, queueIn chatId: String? = nil) async throws {
        let deadline = Date().addingTimeInterval(60)
        while true {
            c.nudge()
            do {
                if let chatId {
                    _ = try await c.call(Channels.chatQueue, [.string(chatId), prompt], timeout: 15)
                } else {
                    _ = try await c.call(Channels.chatSend, [prompt], timeout: 15)
                }
                return
            } catch let e as RelayError where e.fromComputer {
                throw e
            } catch {
                if Date() > deadline { throw error }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    /// `GET <ctl>/stop` or `/start` on the stack's relay controller (scripts/relay-ctl.mjs).
    private func relay(_ ctl: String, _ action: String) async throws {
        let url = try XCTUnwrap(URL(string: "\(ctl)/\(action)"))
        let status: Int = try await withCheckedThrowingContinuation { k in
            URLSession.shared.dataTask(with: url) { _, response, error in
                if let error { k.resume(throwing: error) } else { k.resume(returning: (response as? HTTPURLResponse)?.statusCode ?? 0) }
            }.resume()
        }
        XCTAssertEqual(status, 200, "relay \(action)")
    }

    /// IO-20: a pairing with two routes to one relay (the stack's route proxy
    /// first, the relay itself second). Taking the first down moves the phone
    /// to the second at once; bringing it back moves the phone back after the
    /// probes and the dwell, with requests answered on each route.
    func testD_FailsOverBetweenTwoRoutesAndComesBack() async throws {
        guard let env = Self.env else { throw XCTSkip("set NEKKO_ITEST_* (apps/ios/scripts/itest.sh)") }
        let e = ProcessInfo.processInfo.environment
        guard let route = e["NEKKO_ITEST_ROUTE"], let ctl = e["NEKKO_ITEST_ROUTE_CTL"] else { throw XCTSkip("set NEKKO_ITEST_ROUTE(_CTL)") }
        guard let device = Self.enrolled else { throw XCTSkip("needs testB's enrolled phone") }
        let link = try XCTUnwrap(Pairing.parse("nekko-agent-pair:?relay=\(route)&room=\(env.room)&key=\(env.key)&alt=\(env.relay)"))
        XCTAssertEqual(link.alts, [env.relay])
        var cfg = RelayConfig(relayUrl: link.relayUrl, room: env.room, key: env.key, keyBytes: env.keyBytes, deviceId: device,
                              deviceName: "iOS itest")
        cfg.alternates = link.alts
        cfg.requestTimeout = 30
        var rules = RouteRules()
        rules.openTimeout = 3
        rules.probeInterval = 0.3
        rules.failureCooldown = 1
        rules.minDwell = 1
        cfg.routeRules = rules
        #if os(Linux)
        let transport: WsTransport = SocketTransport()
        #else
        let transport: WsTransport = URLSessionTransport()
        #endif
        let c = RelayClient(config: cfg, transport: transport, prober: HealthProber())
        let r = RelayClientTests.Recorder()
        r.attach(c)
        c.connect()
        await r.await({ $0.state == .online && $0.route == route }, timeout: 15)
        try await assertAnswers(c)

        try await control(ctl, "down")
        await r.await({ $0.state == .online && $0.route == env.relay }, timeout: 15)
        try await assertAnswers(c)
        print("itest: route down, the phone moved to \(Pairing.relayHost(env.relay))")

        try await control(ctl, "up")
        await r.await({ $0.state == .online && $0.route == route }, timeout: 20)
        try await assertAnswers(c)
        print("itest: route back, the phone moved back to \(Pairing.relayHost(route))")
        c.close()
    }

    func assertAnswers(_ c: RelayClient) async throws {
        let info = AppInfo.from(try await c.call(Channels.appInfo))
        XCTAssertFalse((info.version ?? "").isEmpty)
    }

    /// `GET <ctl>/down` or `/up` on the stack's route proxy (scripts/route-proxy.mjs).
    func control(_ ctl: String, _ action: String) async throws {
        let url = try XCTUnwrap(URL(string: "\(ctl)/\(action)"))
        let ok: Bool = await withCheckedContinuation { cont in
            URLSession.shared.dataTask(with: url) { _, res, err in
                cont.resume(returning: err == nil && (res as? HTTPURLResponse)?.statusCode == 200)
            }.resume()
        }
        XCTAssertTrue(ok, "route proxy \(action)")
    }
}
