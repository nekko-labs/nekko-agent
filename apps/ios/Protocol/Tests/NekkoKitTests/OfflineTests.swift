import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// The phone's files in memory, counting writes.
@MainActor
final class MemoryOfflineFiles: OfflineFiles {
    var files: [String: JSONValue] = [:]
    var saves = 0
    func load(_ computerId: String, _ name: String) -> JSONValue? { files["\(computerId)/\(name)"] }
    func save(_ computerId: String, _ name: String, _ value: JSONValue) {
        saves += 1
        files["\(computerId)/\(name)"] = value
    }
    func remove(_ computerId: String) { files = files.filter { !$0.key.hasPrefix("\(computerId)/") } }
}

/// A computer's chats as the outbox sees them. `chat:send` and `chat:queue`
/// take each `clientMessageId` once, as the host and the daemon do; the
/// switches below lose the answer, the whole call, or refuse.
final class FakeComputer: Caller, @unchecked Sendable {
    struct Chat {
        var ids: [String] = []
        var prompts: [String] = []
        var queued: [String] = []
        var running = false
    }

    private let lock = NSLock()
    var chats: [String: Chat] = [:]
    private var calls: [(String, [JSONValue])] = []
    /// Nothing gets through (offline, relay down).
    var unreachable = false
    /// The computer takes `chat:send` but its answer never arrives.
    var loseSendAnswer = false
    /// `chat:send` answers with this error.
    var refuseSend: String?
    /// A `chat:send` starts a turn that keeps running (later prompts queue).
    var turnsKeepRunning = false
    /// A computer from before exactly-once delivery: its phone gate refuses `clientMessageId`.
    var old = false
    var created = 0

    init(chats: [String] = []) {
        for c in chats { self.chats[c] = Chat() }
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try handle(channel, args)
    }

    /// One call, answered at once (the store tests' `FakeConnection` replies are synchronous).
    func handle(_ channel: String, _ args: [JSONValue]) throws -> JSONValue {
        lock.lock()
        defer { lock.unlock() }
        calls.append((channel, args))
        if unreachable { throw RelayError("Could not reach your computer.") }
        if old, args.contains(where: { $0.isSet("clientMessageId") }) {
            throw RelayError("Not allowed from a paired phone (option-denied): clientMessageId", fromComputer: true)
        }
        switch channel {
        case Channels.sessionGet:
            return view(args.first?.string ?? "")
        case Channels.sessionCreate:
            created += 1
            let id = "made-\(created)"
            chats[id] = Chat()
            return view(id)
        case Channels.sessionSetOptions:
            return .null
        case Channels.chatSend:
            let o = args.first ?? .null
            let sid = o.str("sessionId") ?? ""
            if let refuseSend { throw RelayError(refuseSend, fromComputer: true) }
            guard var chat = chats[sid] else { throw RelayError("Session not found.", fromComputer: true) }
            let id = o.str("clientMessageId") ?? "-"
            if chat.ids.contains(id) { return .null }
            if chat.running {
                throw RelayError("This chat is already running. Queue the follow-up or interrupt the current reply first.", fromComputer: true)
            }
            chat.ids.append(id)
            chat.prompts.append(o.str("text") ?? "")
            chat.running = turnsKeepRunning
            chats[sid] = chat
            if loseSendAnswer { throw RelayError("Could not reach your computer.") }
            return .null
        case Channels.chatQueue:
            let sid = args.first?.string ?? ""
            guard var chat = chats[sid] else { return .null }
            let item = args.count > 1 ? args[1] : .null
            if let id = item.str("clientMessageId"), !chat.ids.contains(id) {
                chat.ids.append(id)
                chat.queued.append(item.string ?? item.str("text") ?? "")
                chats[sid] = chat
            }
            return view(sid)
        default:
            return .null
        }
    }

    /// `session:get` as the phone receives it.
    private func view(_ id: String) -> JSONValue {
        guard let c = chats[id] else { return .null }
        var o: [String: JSONValue] = [
            "id": .string(id), "title": "T",
            "messages": .array(c.prompts.enumerated().map { .object(["id": .string("u\($0.offset)"), "role": "user", "content": .string($0.element)]) }),
            "queue": .array(c.queued.map { .string($0) }),
            "clientMessageIds": .array(c.ids.map { .string($0) }),
        ]
        if c.running { o["activeRun"] = ["startedAt": 1] }
        return .object(o)
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func chat(_ id: String) -> Chat { locked { chats[id] ?? Chat() } }
    func channels() -> [String] { locked { calls.map { $0.0 } } }
    func count(_ channel: String) -> Int { locked { calls.filter { $0.0 == channel }.count } }
    /// The last call to `channel`, or the first one matching.
    func lastCall(_ channel: String) -> [JSONValue]? { locked { calls.last { $0.0 == channel }?.1 } }
    func firstCall(_ channel: String, where match: ([JSONValue]) -> Bool = { _ in true }) -> [JSONValue]? {
        locked { calls.first { $0.0 == channel && match($0.1) }?.1 }
    }
    func set(_ change: (FakeComputer) -> Void) { locked { change(self) } }
}

/// Runs `before` ahead of each call, then answers as `inner`.
final class RacingComputer: Caller, @unchecked Sendable {
    let inner: FakeComputer
    let before: (String) -> Void
    init(_ inner: FakeComputer, before: @escaping (String) -> Void) {
        self.inner = inner
        self.before = before
    }

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        before(channel)
        return try inner.handle(channel, args)
    }
}

/// A computer that refuses everything (here: creating the chat).
final class RefusingComputer: Caller, @unchecked Sendable {
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        throw RelayError("Folder not found.", fromComputer: true)
    }
}

@MainActor
func settleOffline(_ seconds: Double = 0.05) async {
    for _ in 0..<20 { await Task.yield() }
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
    for _ in 0..<20 { await Task.yield() }
}

@MainActor
final class DraftStoreTests: XCTestCase {
    func testDraftsAreKeptPerChatAndPerComputerAndSurviveARestart() async {
        let files = MemoryOfflineFiles()
        let d = DraftStore(files: files, debounce: 0)
        d.load("c1")
        let photo = "data:image/jpeg;base64,AA"
        d.set("s1", Draft(text: "half a thought", skill: SkillSummary(name: "review", description: "Review"), images: [photo]))
        d.set(DraftStore.newChat, Draft(text: "start", providerId: "p", modelId: "m", workspaceId: "w", mode: "ask"))
        await settleOffline()

        // iOS ended the app: a new store reads what was typed.
        let again = DraftStore(files: files)
        again.load("c1")
        XCTAssertEqual(again.draft("s1").text, "half a thought")
        XCTAssertEqual(again.draft("s1").skill?.name, "review")
        XCTAssertEqual(again.draft("s1").images, [photo])
        XCTAssertEqual(again.draft(DraftStore.newChat), Draft(text: "start", providerId: "p", modelId: "m", workspaceId: "w", mode: "ask"))
        // Another computer has its own.
        again.load("c2")
        XCTAssertTrue(again.drafts.isEmpty)
        again.load("c1")
        // Emptying a composer removes its draft.
        again.set("s1", Draft())
        again.clear(DraftStore.newChat)
        XCTAssertTrue(again.drafts.isEmpty)
        let third = DraftStore(files: files)
        third.load("c1")
        XCTAssertTrue(third.drafts.isEmpty)
        // A file of another version is ignored, not misread.
        files.files["c1/drafts"] = ["v": 99, "drafts": ["s1": ["text": "x"]]]
        third.load("c1")
        XCTAssertTrue(third.drafts.isEmpty)
    }

    func testTypingIsSavedAfterAPauseAndAtOnceOnFlush() async {
        let files = MemoryOfflineFiles()
        let d = DraftStore(files: files, debounce: 60)
        d.load("c1")
        let before = files.saves
        d.set("s1", Draft(text: "a"))
        d.set("s1", Draft(text: "ab"))
        await settleOffline()
        XCTAssertEqual(files.saves, before, "not on every keystroke")
        d.flush()
        XCTAssertEqual(files.saves, before + 1)
        XCTAssertEqual(files.files["c1/drafts"]?["drafts"]?["s1"]?.str("text"), "ab")
    }

    func testARefusedPromptComesBackInFrontOfWhatWasTyped() {
        let d = DraftStore(files: nil)
        d.load("c1")
        d.set("s1", Draft(text: "typed since", images: ["b"]))
        d.handBack("s1", Draft(text: "the refused one", skill: SkillSummary(name: "fix"), images: ["a"], refusal: "Model gone."))
        let back = d.draft("s1")
        XCTAssertEqual(back.text, "the refused one\n\ntyped since")
        XCTAssertEqual(back.images, ["a", "b"])
        XCTAssertEqual(back.skill?.name, "fix")
        XCTAssertEqual(back.refusal, "Model gone.")
    }
}

@MainActor
final class OutboxTests: XCTestCase {
    var n = 0

    func outbox(_ caller: Caller?, files: OfflineFiles? = nil, drafts: DraftStore) -> Outbox {
        let o = Outbox(files: files, drafts: drafts, caller: { caller },
                       defaults: { RemoteDefaults(defaultProviderId: "p", defaultModelId: "m") },
                       newId: { self.n += 1; return "cm-\(self.n)" }, now: { 5 }, pollInterval: 0.01, confirmTimeout: 0.5)
        o.load("c1")
        return o
    }

    func drafts(_ files: OfflineFiles? = nil) -> DraftStore {
        let d = DraftStore(files: files, debounce: 0)
        d.load("c1")
        return d
    }

    func testDeliversInOrderOneAtATimeAndQueuesWhileAChatRuns() async {
        let pc = FakeComputer(chats: ["a", "b"])
        pc.turnsKeepRunning = true
        let o = outbox(pc, drafts: drafts())
        o.add(chatId: "a", text: "one")
        o.add(chatId: "b", text: "two", skill: SkillSummary(name: "review"), images: ["data:image/jpeg;base64,AA"])
        o.add(chatId: "a", text: "three")
        XCTAssertEqual(o.count(for: "a"), 2)
        await o.flush()
        XCTAssertTrue(o.items.isEmpty)
        XCTAssertEqual(pc.chat("a").prompts, ["one"])
        XCTAssertEqual(pc.chat("a").queued, ["three"], "a is running its first prompt, so the next waits in its queue")
        XCTAssertEqual(pc.chat("b").prompts, ["two"])
        let sends = pc.channels().filter { $0 == Channels.chatSend || $0 == Channels.chatQueue }
        XCTAssertEqual(sends, [Channels.chatSend, Channels.chatSend, Channels.chatQueue])
        let sendB = pc.firstCall(Channels.chatSend) { $0.first?.str("sessionId") == "b" }?.first
        XCTAssertEqual(sendB?.str("clientMessageId"), "cm-2")
        XCTAssertEqual(sendB?["skill"], ["name": "review", "input": "two"])
        XCTAssertEqual(sendB?.str("modelId"), "m", "the computer's default model")
    }

    func testNothingGetsThroughSoItWaitsThenGoesOnce() async {
        let pc = FakeComputer(chats: ["a"])
        pc.unreachable = true
        let files = MemoryOfflineFiles()
        let o = outbox(pc, files: files, drafts: drafts(files))
        o.add(chatId: "a", text: "hello")
        await o.flush()
        XCTAssertEqual(o.items.count, 1)
        XCTAssertEqual(o.items.first?.lastError, "Could not reach your computer.")
        // The app was killed meanwhile: the outbox is read back from disk.
        let again = outbox(pc, files: files, drafts: drafts(files))
        XCTAssertEqual(again.items.map(\.text), ["hello"])
        pc.set { $0.unreachable = false }
        await again.flush()
        XCTAssertTrue(again.items.isEmpty)
        XCTAssertEqual(pc.chat("a").prompts, ["hello"])
    }

    func testALostAnswerIsConfirmedFromTheChatNotSentTwice() async {
        let pc = FakeComputer(chats: ["a"])
        pc.loseSendAnswer = true
        let o = outbox(pc, drafts: drafts())
        o.add(chatId: "a", text: "exactly once")
        await o.flush()
        XCTAssertTrue(o.items.isEmpty, "the chat lists the id, so it was delivered")
        XCTAssertEqual(pc.chat("a").prompts, ["exactly once"])

        // The connection died right after the computer took it: the next flush
        // finds the id on the chat and sends nothing.
        pc.set {
            $0.loseSendAnswer = false
            $0.chats["a"]?.ids.append("cm-9")
            $0.chats["a"]?.prompts.append("taken before the drop")
        }
        o.add(chatId: "a", text: "taken before the drop", id: "cm-9")
        let sendsBefore = pc.count(Channels.chatSend)
        await o.flush()
        XCTAssertTrue(o.items.isEmpty)
        XCTAssertEqual(pc.count(Channels.chatSend), sendsBefore)
        XCTAssertEqual(pc.chat("a").prompts, ["exactly once", "taken before the drop"])
    }

    func testARefusalGoesBackToTheDraftWithTheReason() async {
        let pc = FakeComputer(chats: ["a"])
        pc.refuseSend = "The model m is not available."
        let d = drafts()
        let o = outbox(pc, drafts: d)
        o.add(chatId: "a", text: "please", images: ["data:image/jpeg;base64,AA"])
        o.add(chatId: "gone", text: "to a deleted chat")
        await o.flush()
        XCTAssertTrue(o.items.isEmpty)
        XCTAssertEqual(d.draft("a").text, "please")
        XCTAssertEqual(d.draft("a").images.count, 1)
        XCTAssertEqual(d.draft("a").refusal, "The model m is not available.")
        XCTAssertEqual(d.draft("gone").refusal, "This chat was deleted on your computer.")
    }

    func testAChatThatStartedRunningMeanwhileGetsItQueued() async {
        let pc = FakeComputer(chats: ["a"])
        // The phone's read says idle; then another device starts a turn before the send lands.
        var first = true
        let racing = RacingComputer(pc) { channel in
            if channel == Channels.chatSend && first {
                first = false
                pc.set { $0.chats["a"]?.running = true }
            }
        }
        let o = outbox(racing, drafts: drafts())
        o.add(chatId: "a", text: "follow-up")
        await o.flush()
        XCTAssertTrue(o.items.isEmpty)
        XCTAssertEqual(pc.chat("a").queued, ["follow-up"])
        XCTAssertEqual(pc.chat("a").prompts, [])
    }

    func testAChatStartedOfflineIsCreatedOnceThenSent() async {
        let pc = FakeComputer()
        let files = MemoryOfflineFiles()
        let d = drafts(files)
        // The chat is created, then the connection drops before the prompt goes.
        let dropping = RacingComputer(pc) { channel in
            if channel == Channels.sessionSetOptions { pc.set { $0.unreachable = true } }
        }
        let first = outbox(dropping, files: files, drafts: d)
        let item = first.add(chatId: nil, text: "new idea", newChat: NewChatSpec(providerId: "p2", modelId: "m2", workspaceId: "w", mode: "ask"))
        XCTAssertEqual(first.pendingNewChats.map(\.id), [item.id])
        await first.flush()
        XCTAssertEqual(first.items.first?.chatId, "made-1", "the new chat's id is saved at once")
        XCTAssertEqual(first.created[item.chatKey], "made-1")
        // Back online, from a fresh start: no second chat, the prompt goes to the first.
        pc.set { $0.unreachable = false }
        let again = outbox(pc, files: files, drafts: d)
        await again.flush()
        XCTAssertTrue(again.items.isEmpty)
        XCTAssertEqual(pc.count(Channels.sessionCreate), 1)
        XCTAssertEqual(pc.firstCall(Channels.sessionCreate), ["w"])
        XCTAssertEqual(pc.lastCall(Channels.sessionSetOptions), ["made-1", ["providerId": "p2", "modelId": "m2", "mode": "ask"]])
        XCTAssertEqual(pc.chat("made-1").prompts, ["new idea"])
        XCTAssertEqual(pc.lastCall(Channels.chatSend)?.first?.str("modelId"), "m2")
    }

    func testARefusedNewChatGoesBackToNewChatWithItsChoices() async {
        let d = drafts()
        let o = outbox(RefusingComputer(), drafts: d)
        o.add(chatId: nil, text: "idea", newChat: NewChatSpec(providerId: "p", modelId: "m", workspaceId: "w"))
        await o.flush()
        XCTAssertTrue(o.items.isEmpty)
        let back = d.draft(DraftStore.newChat)
        XCTAssertEqual(back.text, "idea")
        XCTAssertEqual(back.providerId, "p")
        XCTAssertEqual(back.workspaceId, "w")
        XCTAssertEqual(back.refusal, "Folder not found.")
    }

    func testEditDeleteAndHandingEverythingBack() async {
        let files = MemoryOfflineFiles()
        let d = drafts(files)
        let o = outbox(nil, files: files, drafts: d)
        let a = o.add(chatId: "a", text: "edit me")
        let b = o.add(chatId: "a", text: "delete me")
        let c = o.add(chatId: "b", text: "unpaired")
        XCTAssertEqual(files.files["c1/outbox"]?["items"]?.array?.count, 3, "saved as soon as it is added")
        XCTAssertEqual(o.items(for: "a").map(\.preview), ["edit me", "delete me"])
        XCTAssertEqual(o.takeBack(a.id), "a")
        XCTAssertEqual(d.draft("a").text, "edit me")
        XCTAssertTrue(o.remove(b.id))
        XCTAssertEqual(o.items.map(\.id), [c.id])
        o.handBackAll(reason: "This phone is no longer paired with Mac.")
        XCTAssertTrue(o.items.isEmpty)
        XCTAssertEqual(d.draft("b").refusal, "This phone is no longer paired with Mac.")
        XCTAssertEqual(files.files["c1/outbox"]?["items"]?.array?.count, 0)
        // Nothing to flush without a connection.
        await o.flush()
    }
}

@MainActor
final class OfflineStoreTests: XCTestCase {
    func makeOnline(files: MemoryOfflineFiles, computer: FakeComputer) async throws -> (ComputersStore, FakeConnection) {
        var conns: [FakeConnection] = []
        let s = ComputersStore(store: MemoryStore(), makeConnection: { cfg in
            let c = FakeConnection(config: cfg)
            c.replies = [
                Channels.settingsGet: { _ in ["defaultProviderId": "p", "defaultModelId": "m"] },
                Channels.chatPending: { _ in [:] },
            ]
            for ch in [Channels.sessionGet, Channels.chatSend, Channels.chatQueue, Channels.sessionCreate, Channels.sessionSetOptions] {
                c.replies[ch] = { args in try computer.handle(ch, args) }
            }
            conns.append(c)
            return c
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) },
           offlineFiles: files, draftDebounce: 0, outboxPoll: 0.01, outboxConfirmTimeout: 0.5)
        s.load()
        await s.pair(PairingLink(relayUrl: "wss://r", room: "a1b2c3d4e5f60718", key: "00112233445566778899aabbccddeeff"))
        conns[0].online()
        await settleOffline()
        return (s, conns[0])
    }

    func testAPromptWrittenOfflineGoesWhenTheComputerIsBack() async throws {
        let files = MemoryOfflineFiles()
        let pc = FakeComputer(chats: ["s"])
        let (s, c) = try await makeOnline(files: files, computer: pc)
        let chat = ChatModel(sessionId: "s", store: s)
        c.status(RelayStatus(.offline))
        await settleOffline()
        try await chat.send("written on the train")
        XCTAssertEqual(chat.waiting.map(\.text), ["written on the train"])
        XCTAssertEqual(s.outbox.count, 1)
        XCTAssertEqual(pc.count(Channels.chatSend), 0)
        let id = try XCTUnwrap(s.activeId)
        XCTAssertEqual(files.files["\(id)/outbox"]?["items"]?.array?.count, 1)

        c.status(RelayStatus(.online))
        await settleOffline(0.4)
        XCTAssertTrue(s.outbox.items.isEmpty)
        XCTAssertEqual(pc.chat("s").prompts, ["written on the train"])
        XCTAssertEqual(pc.chat("s").ids.count, 1)
    }

    func testADroppedSendGoesToTheOutboxWithItsIdAndIsDeliveredOnce() async throws {
        let files = MemoryOfflineFiles()
        let pc = FakeComputer(chats: ["s"])
        pc.loseSendAnswer = true
        let (s, c) = try await makeOnline(files: files, computer: pc)
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settleOffline()
        try await chat.send("did it arrive?")
        await settleOffline()
        // No answer: kept on the phone, with the id the computer already has.
        XCTAssertEqual(s.outbox.items.map(\.text), ["did it arrive?"])
        XCTAssertEqual(s.outbox.items.first?.id, pc.chat("s").ids.first)
        XCTAssertNil(chat.takeUnsent())
        pc.set { $0.loseSendAnswer = false }
        c.status(RelayStatus(.connecting))
        c.status(RelayStatus(.online))
        await settleOffline(0.4)
        XCTAssertTrue(s.outbox.items.isEmpty)
        XCTAssertEqual(pc.chat("s").prompts, ["did it arrive?"], "exactly once")
        chat.stop()
    }

    func testAnOlderComputerGetsTheSendWithoutAnIdAndTheOutboxHandsBack() async throws {
        let pc = FakeComputer(chats: ["s"])
        pc.old = true
        let (s, c) = try await makeOnline(files: MemoryOfflineFiles(), computer: pc)
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settleOffline()
        // Online: sent as before, without the id, and nothing is left behind.
        try await chat.send("hello old computer")
        await settleOffline()
        XCTAssertEqual(pc.lastCall(Channels.chatSend)?.first?.isSet("clientMessageId"), false)
        XCTAssertTrue(s.outbox.items.isEmpty)
        // Written offline: never sent without an id (a resend could run twice), so it comes back.
        c.status(RelayStatus(.offline))
        await settleOffline()
        try await chat.send("written offline")
        c.status(RelayStatus(.online))
        await settleOffline(0.3)
        XCTAssertTrue(s.outbox.items.isEmpty)
        XCTAssertEqual(s.drafts.draft("s").text, "written offline")
        XCTAssertEqual(s.drafts.draft("s").refusal, Outbox.needsUpdate)
        chat.stop()
    }

    func testApprovalsAreNeverQueued() async throws {
        let (s, c) = try await makeOnline(files: MemoryOfflineFiles(), computer: FakeComputer(chats: ["s"]))
        let chat = ChatModel(sessionId: "s", store: s)
        chat.start()
        await settleOffline()
        c.event(["type": "tool_approval_required", "sessionId": "s", "call": ["id": "t", "name": "bash", "input": ["command": "ls"]], "reason": "r", "severity": "low"])
        await settleOffline()
        c.status(RelayStatus(.offline))
        await settleOffline()
        do {
            try await chat.approve(true)
            XCTFail("an approval was accepted offline")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.reconnectToAnswer)
        }
        XCTAssertEqual(chat.turn.approval?.call.id, "t")
        XCTAssertTrue(s.outbox.items.isEmpty)
        chat.stop()
    }

    func testUnpairingHandsPromptsBackAndForgetDeletesTheFiles() async throws {
        let files = MemoryOfflineFiles()
        let (s, c) = try await makeOnline(files: files, computer: FakeComputer(chats: ["s"]))
        let id = try XCTUnwrap(s.activeId)
        c.status(RelayStatus(.offline))
        await settleOffline()
        s.outbox.add(chatId: "s", text: "pending")
        s.drafts.set("s2", Draft(text: "typing"))
        s.drafts.flush()
        c.status(RelayStatus(.denied, denied: .revoked))
        await settleOffline()
        XCTAssertTrue(s.outbox.items.isEmpty)
        XCTAssertEqual(s.drafts.draft("s").text, "pending")
        XCTAssertTrue(s.drafts.draft("s").refusal?.contains("no longer paired") == true)
        XCTAssertFalse(files.files.isEmpty)
        s.forget(id)
        XCTAssertTrue(files.files.keys.allSatisfy { !$0.hasPrefix("\(id)/") }, "Forget deletes this computer's drafts and outbox")
        XCTAssertTrue(s.drafts.drafts.isEmpty)
    }
}
