import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Saved chats in memory, per computer.
final class MemoryTranscriptCache: TranscriptCache, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: Data] = [:]
    private var writeCount = 0
    private var wipeCount = 0
    var files: [String: Data] { lock.withLock { store } }
    var writes: Int { lock.withLock { writeCount } }
    var wipes: Int { lock.withLock { wipeCount } }
    func load(_ computerId: String, _ name: String) -> Data? { lock.withLock { store["\(computerId)/\(name)"] } }
    func save(_ computerId: String, _ name: String, _ data: Data) {
        lock.withLock {
            writeCount += 1
            store["\(computerId)/\(name)"] = data
        }
    }
    func removeFile(_ computerId: String, _ name: String) { lock.withLock { store["\(computerId)/\(name)"] = nil } }
    func removeComputer(_ computerId: String) { lock.withLock { store = store.filter { !$0.key.hasPrefix("\(computerId)/") } } }
    func removeAll() {
        lock.withLock {
            wipeCount += 1
            store = [:]
        }
    }
    /// The chat files of one computer (not its index).
    func chats(_ computerId: String) -> [String] {
        files.keys.filter { $0.hasPrefix("\(computerId)/chat-") }.sorted()
    }
}

/// `session:get` as the phone receives it, with `n` messages of `size` characters each.
func sessionJSON(_ id: String, messages n: Int = 2, size: Int = 10, images: Int = 0) -> JSONValue {
    var msgs: [JSONValue] = []
    for i in 0..<n {
        var m: [String: JSONValue] = [
            "id": .string("\(id)-m\(i)"), "role": .string(i % 2 == 0 ? "user" : "assistant"),
            "content": .string("\(i):" + String(repeating: "x", count: size)), "createdAt": .int(Int64(i)),
        ]
        if i == 0, images > 0 {
            m["images"] = .array((0..<images).map { _ in .string("data:image/jpeg;base64," + String(repeating: "A", count: 4000)) })
        }
        msgs.append(.object(m))
    }
    return [
        "id": .string(id), "title": "Fix the build", "providerId": "p", "modelId": "m", "workspaceId": "w", "mode": "ask",
        "updatedAt": 9, "messages": .array(msgs), "queue": ["later"], "clientMessageIds": ["c1"], "activeRun": ["startedAt": 1],
    ]
}

func session(_ id: String, messages n: Int = 2, size: Int = 10, images: Int = 0) -> Session {
    Session.from(sessionJSON(id, messages: n, size: size, images: images))!
}

@MainActor
final class SavedTranscriptsTests: XCTestCase {
    var clock: Int64 = 1_000

    func make(_ files: MemoryTranscriptCache, maxChats: Int = 20, maxBytes: Int = 5 * 1024 * 1024,
              maxChatBytes: Int = 1024 * 1024) -> SavedTranscripts {
        let t = SavedTranscripts(maxChats: maxChats, maxBytes: maxBytes, maxChatBytes: maxChatBytes, now: { [unowned self] in
            self.clock += 1
            return self.clock
        })
        t.use(files, computerId: "pc")
        return t
    }

    func testKeepsWhatTheChatShowsButNoPhotosQueueOrOutboxIds() async throws {
        let files = MemoryTranscriptCache()
        let t = make(files)
        t.save(session("s", messages: 3, images: 2))
        await t.flush()
        let raw = try XCTUnwrap(files.chats("pc").first.flatMap { files.files[$0] })
        let text = String(decoding: raw, as: UTF8.self)
        XCTAssertFalse(text.contains("base64"), "photo data is never written")
        XCTAssertFalse(text.contains("later"), "nor the computer's queue")
        XCTAssertFalse(text.contains("c1"), "nor the outbox ids")
        let back = try XCTUnwrap(make(files).saved("s"))
        XCTAssertEqual(back.session.title, "Fix the build")
        XCTAssertEqual(back.session.modelId, "m")
        XCTAssertEqual(back.session.mode, "ask")
        XCTAssertEqual(back.session.messages.map(\.id), ["s-m0", "s-m1", "s-m2"])
        XCTAssertEqual(back.session.messages.first?.imageCount, 2, "how many photos, as the transcript shows")
        XCTAssertTrue(back.session.queue.isEmpty)
        XCTAssertTrue(back.session.clientMessageIds.isEmpty)
        XCTAssertFalse(back.session.running)
        XCTAssertEqual(Transcript.fromMessages(back.session.messages), Transcript.fromMessages(session("s", messages: 3, images: 2).messages))
    }

    func testToolStepsSurviveTheRoundTrip() async throws {
        let raw: JSONValue = [
            "id": "s", "title": "T", "updatedAt": 1,
            "messages": [
                ["id": "a", "role": "assistant", "content": "", "toolCalls": [["id": "t1", "name": "bash", "input": ["command": "ls"]]]],
                ["id": "r", "role": "tool", "toolResult": ["toolCallId": "t1", "output": "a\nb", "isError": true, "truncated": true, "outputChars": 99, "omittedImages": 1]],
                ["id": "u", "role": "user", "content": "go", "skill": ["name": "review", "input": "PR"], "interrupted": true],
            ],
        ]
        let s = try XCTUnwrap(Session.from(raw))
        let files = MemoryTranscriptCache()
        let writer = make(files)
        writer.save(s)
        await writer.flush()
        let back = try XCTUnwrap(make(files).saved("s")).session
        XCTAssertEqual(back.messages, s.messages)
    }

    func testTheLeastRecentlyOpenedGoesPastTheCount() async {
        let files = MemoryTranscriptCache()
        let t = make(files, maxChats: 3)
        for id in ["a", "b", "c"] { t.save(session(id)) }
        await t.flush()
        t.touch("a")
        t.save(session("d"))
        await t.flush()
        XCTAssertEqual(Set(t.chatIds), ["a", "c", "d"], "b was opened longest ago")
        XCTAssertNil(t.saved("b"))
        XCTAssertEqual(files.chats("pc").count, 3, "its file is gone too")
        XCTAssertEqual(make(files, maxChats: 3).chatIds, ["d", "a", "c"], "the order survives a restart")
    }

    func testTheLeastRecentlyOpenedGoesPastTheByteCap() async {
        let files = MemoryTranscriptCache()
        let one = SavedTranscripts.encode(SavedTranscript(savedAt: 1, session: session("a", size: 2_000)), limit: .max)!.data.count
        let t = make(files, maxBytes: one * 2 + one / 2, maxChatBytes: one * 2)
        for id in ["a", "b", "c"] { t.save(session(id, size: 2_000)) }
        await t.flush()
        XCTAssertEqual(t.chatIds, ["c", "b"])
        XCTAssertLessThanOrEqual(t.totalBytes, t.maxBytes)
        XCTAssertEqual(files.chats("pc").count, 2)
    }

    func testALongChatKeepsItsNewestMessages() async throws {
        let files = MemoryTranscriptCache()
        let t = make(files, maxChatBytes: 20_000)
        t.save(session("s", messages: 40, size: 1_000))
        await t.flush()
        let back = try XCTUnwrap(t.saved("s")).session
        XCTAssertLessThan(back.messages.count, 40)
        XCTAssertEqual(back.messages.last?.id, "s-m39", "the newest message stays")
        XCTAssertEqual(back.omittedMessages + back.messages.count, 40, "the rest are counted as on the computer")
        XCTAssertLessThanOrEqual(t.totalBytes, 20_000)
        // One message bigger than a chat may be: no copy rather than a misleading part.
        t.save(session("s", messages: 1, size: 30_000))
        await t.flush()
        XCTAssertNil(t.saved("s"))
        XCTAssertTrue(files.chats("pc").isEmpty)
    }

    func testTheSameChatIsNotWrittenAgain() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        t.save(session("s"))
        await t.flush()
        let writes = files.writes
        t.save(session("s"))
        await t.flush()
        XCTAssertEqual(files.writes, writes + 1, "only the index (the order) is written")
        t.save(session("s", messages: 3))
        await t.flush()
        XCTAssertEqual(files.writes, writes + 3, "the chat and the index")
    }

    func testABurstOfSavesIsOneWrite() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        for n in 1...12 { t.save(session("s", messages: n)) }
        XCTAssertEqual(files.writes, 0, "nothing is written on the main thread, and not yet")
        XCTAssertNil(t.saved("zzz"))
        XCTAssertEqual(t.saved("s")?.session.messages.count, 12, "a read sees the newest copy before it is on disk")
        await t.flush()
        XCTAssertEqual(files.chats("pc").count, 1)
        XCTAssertEqual(files.writes, 2, "one chat file and one index for twelve saves")
        XCTAssertEqual(t.saved("s")?.session.messages.count, 12)
        XCTAssertEqual(t.chatIds, ["s"])
    }

    func testAChatRemovedWhileItsWriteWaitsStaysGone() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        t.save(session("a"))
        t.save(session("b"))
        t.remove("a")
        await t.flush()
        XCTAssertEqual(t.chatIds, ["b"])
        XCTAssertEqual(files.chats("pc").count, 1)
        XCTAssertNil(t.saved("a"))
    }

    func testSwitchingComputersKeepsWhatWasStillWaiting() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        t.save(session("a"))
        t.load("other")
        XCTAssertTrue(t.chatIds.isEmpty)
        t.load("pc")
        XCTAssertEqual(t.chatIds, ["a"], "the first computer's save landed, in its index, before the switch")
        XCTAssertNotNil(t.saved("a"))
    }

    func testAWipeDropsWhatWasStillWaiting() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        t.save(session("a"))
        t.wipeAll(files)
        await t.flush()
        XCTAssertTrue(files.files.isEmpty, "a queued save does not bring a wiped chat back")
        XCTAssertTrue(t.chatIds.isEmpty)
    }

    /// The main thread's share of a save of a changed 300-message chat: file it away.
    /// Recorded for perf-history; the sessions are built before the clock starts.
    func testMeasureMainThreadCostOfASave() {
        let sessions = (0..<5).map { session("s\($0)", messages: 300, size: 2_000) }
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTClockMetric()], options: options) {
            let t = make(MemoryTranscriptCache())
            startMeasuring()
            for s in sessions { t.save(s) }
            stopMeasuring()
            let done = expectation(description: "flushed")
            Task { @MainActor in await t.flush(); done.fulfill() }
            wait(for: [done], timeout: 30)
        }
    }

    /// The same chat saved again with nothing new (a reload after the turn ended).
    func testMeasureMainThreadCostOfAnUnchangedSave() async {
        let s = session("s", messages: 300, size: 2_000)
        let t = make(MemoryTranscriptCache())
        t.save(s)
        await t.flush()
        measure(metrics: [XCTClockMetric()]) { for _ in 0..<10 { t.save(s) } }
    }

    /// What it was: encode and hash the same chat on the main thread (the old `save`).
    func testMeasureEncodeAndHashOfASave() {
        let long = SavedTranscript(savedAt: 1, session: session("s", messages: 300, size: 2_000))
        measure(metrics: [XCTClockMetric()]) { for _ in 0..<5 { _ = SavedTranscripts.encode(long, limit: 1024 * 1024) } }
    }

    func testRemoveAndKeepOnly() async {
        let files = MemoryTranscriptCache()
        let t = make(files)
        for id in ["a", "b", "c"] { t.save(session(id)) }
        await t.flush()
        t.remove("a")
        t.keepOnly(["c", "zzz"])
        await t.flush()
        XCTAssertEqual(t.chatIds, ["c"])
        XCTAssertEqual(files.chats("pc").count, 1)
    }

    func testNothingIsKeptWithoutFiles() {
        let t = SavedTranscripts()
        t.load("pc")
        t.save(session("s"))
        XCTAssertNil(t.saved("s"))
        XCTAssertTrue(t.chatIds.isEmpty)
    }

    func testAnotherVersionIsIgnored() {
        XCTAssertNil(SavedTranscript.from(["v": 2, "savedAt": 1, "session": sessionJSON("s")]))
        XCTAssertNil(SavedTranscript.from(["v": 1, "savedAt": 1]))
        XCTAssertNotNil(SavedTranscript.from(["v": 1, "savedAt": 1, "session": sessionJSON("s")]))
    }

    /// OF-9: on unless the user turned it off.
    func testOfflineSwitchesAreOnUnlessTurnedOff() {
        XCTAssertTrue(OfflineSetting.isOn(stored: nil), "a new install, or one that never touched the switch")
        XCTAssertFalse(OfflineSetting.isOn(stored: false), "a deliberate off stays off")
        XCTAssertTrue(OfflineSetting.isOn(stored: true))
    }
}

extension StoreTests {
    func makeStoreWithChat(_ files: MemoryTranscriptCache) -> ComputersStore {
        let s = makeStore()
        s.transcriptCache = files
        return s
    }

    func chatReplies(_ c: FakeConnection, title: String = "Fix the build") {
        c.replies[Channels.sessionGet] = { args in
            var v = sessionJSON(args.first?.string ?? "", messages: 2)
            if case .object(var o) = v { o["title"] = .string(title); o["clientMessageIds"] = []; o["activeRun"] = nil; v = .object(o) }
            return v
        }
    }

    func testAnOpenedChatIsReadableOfflineAndPaintsAtOnce() async throws {
        let files = MemoryTranscriptCache()
        let s = makeStoreWithChat(files)
        s.load()
        let id = try await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, hostKey: testHostKey))
        let c = try XCTUnwrap(connections.last)
        chatReplies(c)
        c.online()
        await settle()
        let chat = ChatModel(sessionId: "s1", store: s)
        chat.start()
        await settle()
        XCTAssertNil(chat.savedAt)
        await s.transcripts.flush()
        XCTAssertEqual(s.transcripts.chatIds, ["s1"])
        chat.stop()

        // Next launch, the computer unreachable: the chat is on screen before any answer.
        let s2 = makeStoreWithChat(files)
        s2.load()
        XCTAssertEqual(s2.activeId, id)
        connections.last!.replies[Channels.sessionGet] = { _ in throw RelayError("Could not reach your computer.") }
        let offline = ChatModel(sessionId: "s1", store: s2)
        offline.start()
        XCTAssertTrue(offline.ready, "painted at once, no spinner")
        XCTAssertEqual(offline.title, "Fix the build")
        XCTAssertEqual(offline.blocks.map(\.id), ["s1-m0", "s1-m1"])
        XCTAssertEqual(offline.savedAt, 1_000)
        connections.last!.status(RelayStatus(.offline))
        await settle()
        XCTAssertNotNil(offline.savedAt, "still the saved copy")
        XCTAssertNil(offline.error, "the saved copy explains itself; no error on top")

        // The computer answers: the live chat replaces the copy in place.
        let c2 = try XCTUnwrap(connections.last)
        chatReplies(c2, title: "Fix the build, live")
        c2.online()
        await settle()
        offline.connectionChanged(s2.conn)
        await settle()
        XCTAssertNil(offline.savedAt)
        XCTAssertEqual(offline.title, "Fix the build, live")
        XCTAssertEqual(offline.blocks.map(\.id), ["s1-m0", "s1-m1"], "same ids: reconciled in place")
        offline.stop()
    }

    func testTurningTheSwitchOffDeletesEveryCopyAndForgetDeletesTheComputers() async throws {
        let files = MemoryTranscriptCache()
        let s = makeStoreWithChat(files)
        s.load()
        let id = try await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, hostKey: testHostKey))
        chatReplies(connections.last!)
        connections.last!.online()
        await settle()
        let chat = ChatModel(sessionId: "s1", store: s)
        chat.start()
        await settle()
        chat.stop()
        await s.transcripts.flush()
        XCTAssertFalse(files.chats(id).isEmpty)

        s.forget(id)
        XCTAssertTrue(files.files.keys.allSatisfy { !$0.hasPrefix("\(id)/") }, "Forget deletes the computer's saved chats")
        XCTAssertTrue(s.transcripts.chatIds.isEmpty)

        files.save("other", "chat-1", Data("{}".utf8))
        s.transcriptCache = nil
        XCTAssertEqual(files.wipes, 1)
        XCTAssertTrue(files.files.isEmpty, "off deletes the copies on every computer")
    }

    func testAChatDeletedOnTheComputerLeavesNoCopy() async throws {
        let files = MemoryTranscriptCache()
        let s = makeStoreWithChat(files)
        s.load()
        let id = try await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, hostKey: testHostKey))
        let c = try XCTUnwrap(connections.last)
        chatReplies(c)
        c.online()
        await settle()
        for sid in ["s1", "gone"] {
            let chat = ChatModel(sessionId: sid, store: s)
            chat.start()
            await settle()
            chat.stop()
        }
        await s.transcripts.flush()
        XCTAssertEqual(Set(s.transcripts.chatIds), ["s1", "gone"])
        // The next full read of the list doesn't have "gone".
        await s.refresh()
        await s.transcripts.flush()
        XCTAssertEqual(s.transcripts.chatIds, ["s1"])
        XCTAssertEqual(files.chats(id).count, 1)
        // Opening one the computer says is deleted drops its copy.
        c.replies[Channels.sessionGet] = { _ in .null }
        let chat = ChatModel(sessionId: "s1", store: s)
        chat.start()
        XCTAssertNotNil(chat.savedAt)
        await settle()
        XCTAssertNil(chat.savedAt)
        XCTAssertNil(chat.session)
        XCTAssertEqual(chat.error, "This chat was deleted on your computer.")
        XCTAssertTrue(s.transcripts.chatIds.isEmpty)
        chat.stop()
    }

    func testNothingIsSavedWhileTheSwitchIsOff() async throws {
        let s = makeStore()
        s.load()
        try await s.pair(PairingLink(relayUrl: "wss://r", room: room, key: key, hostKey: testHostKey))
        chatReplies(connections.last!)
        connections.last!.online()
        await settle()
        let chat = ChatModel(sessionId: "s1", store: s)
        chat.start()
        await settle()
        chat.stop()
        await s.transcripts.flush()
        XCTAssertTrue(s.transcripts.chatIds.isEmpty)
        // Turned on: the next answer is kept.
        let files = MemoryTranscriptCache()
        s.transcriptCache = files
        await chat.reload()
        await s.transcripts.flush()
        XCTAssertEqual(s.transcripts.chatIds, ["s1"])
    }
}
