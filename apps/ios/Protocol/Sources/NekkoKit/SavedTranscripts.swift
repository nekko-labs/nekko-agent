import Foundation
import NekkoProtocol

/// One chat as the phone last read it, kept to read while the computer is out
/// of reach (TASKS.md OF-5).
public struct SavedTranscript: Equatable, Sendable {
    public let savedAt: Int64
    public let session: Session

    public init(savedAt: Int64, session: Session) {
        self.savedAt = savedAt
        self.session = session
    }

    /// Bumped when the shape changes; an older or newer file is ignored, not misread.
    static let version: Int64 = 1

    /// What is written: the chat's title, model, folder, tool policy and
    /// messages as the phone shows them. Photos never: a message keeps only
    /// how many it had (`imageCount`). Not the queue, the running state or
    /// the outbox ids, which only the computer can say now.
    var json: JSONValue {
        let s = session
        var o: [String: JSONValue] = [
            "id": .string(s.id), "title": .string(s.title), "updatedAt": .int(s.updatedAt),
            "messages": .array(s.messages.map(\.savedJSON)),
        ]
        if let p = s.providerId { o["providerId"] = .string(p) }
        if let m = s.modelId { o["modelId"] = .string(m) }
        if let w = s.workspaceId { o["workspaceId"] = .string(w) }
        if let m = s.mode { o["mode"] = .string(m) }
        if let kind = s.chatType { o["chatType"] = .string(kind) }
        if let params = s.imageParams { o["imageParams"] = params.json }
        if s.omittedMessages > 0 { o["omittedMessages"] = .int(Int64(s.omittedMessages)) }
        return .object(["v": .int(Self.version), "savedAt": .int(savedAt), "session": .object(o)])
    }

    static func from(_ v: JSONValue?) -> SavedTranscript? {
        guard let v, v.long("v") == version, let savedAt = v.long("savedAt"), let s = Session.from(v["session"]) else { return nil }
        return SavedTranscript(savedAt: savedAt, session: s)
    }
}

extension ChatMessage {
    /// The message as `Session.from` reads it back, without photo data.
    var savedJSON: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "role": .string(role), "content": .string(content)]
        if let reasoning { o["reasoning"] = .string(reasoning) }
        if let createdAt { o["createdAt"] = .int(createdAt) }
        if imageCount > 0 { o["imageCount"] = .int(Int64(imageCount)) }
        if let skill { o["skill"] = .object(["name": .string(skill.name), "input": .string(skill.input)]) }
        if !toolCalls.isEmpty {
            o["toolCalls"] = .array(toolCalls.map { .object(["id": .string($0.id), "name": .string($0.name), "input": .object($0.input)]) })
        }
        if let r = toolResult {
            var t: [String: JSONValue] = ["toolCallId": .string(r.toolCallId), "output": .string(r.output)]
            if r.isError { t["isError"] = .bool(true) }
            if let n = r.outputChars { t["truncated"] = .bool(true); t["outputChars"] = .int(Int64(n)) }
            if r.omittedImages > 0 { t["omittedImages"] = .int(Int64(r.omittedImages)) }
            o["toolResult"] = .object(t)
        }
        if interrupted { o["interrupted"] = .bool(true) }
        if let turnStats { o["turnStats"] = turnStats.json }
        return .object(o)
    }
}

/// Where saved chats live. The app keeps one file per chat under Application
/// Support (encrypted until first unlock, not backed up); tests use memory.
/// Not main-actor: `SavedTranscripts` writes and removes from a background
/// queue, so an implementation has to be safe to call from any thread.
public protocol TranscriptCache: AnyObject, Sendable {
    func load(_ computerId: String, _ name: String) -> Data?
    func save(_ computerId: String, _ name: String, _ data: Data)
    func removeFile(_ computerId: String, _ name: String)
    /// Forget: every saved chat of this computer.
    func removeComputer(_ computerId: String)
    /// The setting was turned off, or Forget everything: no saved chat stays behind.
    func removeAll()
}

/// The active computer's saved chats: the last `maxChats` opened, at most
/// `maxBytes` together and `maxChatBytes` each (a longer chat keeps its
/// newest messages). The least recently opened goes first. Saved each time
/// the computer answers for an open chat; nothing is kept while `files` is nil
/// (Settings → Offline → Keep recent chats to read offline, on by default).
///
/// Saving never touches the main thread for more than filing the chat away
/// (#3386): a chat whose messages, last message and update time are unchanged
/// since the last save only moves to the front; any other is queued, and the
/// newest copy per chat is encoded, hashed and written on a background queue
/// about a quarter of a second later, so a burst of re-reads is one write.
/// The list of saved chats (`chatIds`) follows when the write lands; `flush()`
/// waits for it.
@MainActor
public final class SavedTranscripts {
    public static let defaultMaxChats = 20
    public static let defaultMaxBytes = 5 * 1024 * 1024
    public static let defaultMaxChatBytes = 1024 * 1024
    nonisolated static let indexName = "index"
    static let indexVersion: Int64 = 1

    struct Entry: Equatable {
        var id: String
        var file: String
        var openedAt: Int64
        var bytes: Int
        var hash: String
    }

    public let maxChats: Int
    public let maxBytes: Int
    public let maxChatBytes: Int
    private(set) var files: TranscriptCache?
    private(set) var computerId: String?
    /// Most recently opened first.
    private(set) var entries: [Entry] = []
    private let now: () -> Int64
    private let io = BackgroundIO(label: "nekko.saved-transcripts")
    private var writer: CoalescedWriter<Job>!
    private var indexWriter: CoalescedWriter<IndexJob>!
    /// What the last save of each chat looked like, to skip an unchanged one.
    private var signatures: [String: Int] = [:]
    /// Copies queued or being written, newest per chat, so a read sees them.
    private var unsettled: [String: (token: Int, transcript: SavedTranscript)] = [:]
    private var tokens = 0
    /// Bumped when a chat is removed, so a write finishing afterwards is ignored.
    private var removals: [String: Int] = [:]
    /// Bumped when the computer or the folder changes.
    private var epoch = 0

    /// One chat's write, with everything it needs captured on the main thread.
    private struct Job: Sendable {
        var transcript: SavedTranscript
        var files: TranscriptCache
        var computerId: String
        var limit: Int
        var token: Int
        var removal: Int
        var epoch: Int
    }

    /// Finished writes waiting for the main thread to file them in the index.
    private final class Mailbox: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [(Job, (data: Data, hash: String)?)] = []
        func post(_ job: Job, _ encoded: (data: Data, hash: String)?) { lock.withLock { items.append((job, encoded)) } }
        func take() -> [(Job, (data: Data, hash: String)?)] { lock.withLock { let all = items; items = []; return all } }
    }
    private let mailbox = Mailbox()

    private struct IndexJob: Sendable {
        var files: TranscriptCache
        var computerId: String
        var data: Data
    }

    public init(maxChats: Int = defaultMaxChats, maxBytes: Int = defaultMaxBytes, maxChatBytes: Int = defaultMaxChatBytes,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.maxChats = maxChats
        self.maxBytes = maxBytes
        self.maxChatBytes = min(maxChatBytes, maxBytes)
        self.now = now
        let io = io
        let mailbox = mailbox
        writer = CoalescedWriter<Job>(io: io) { [weak self] _, job in
            // Off the main thread: encode, hash, write.
            let encoded = Self.encode(job.transcript, limit: job.limit)
            let id = job.transcript.session.id
            if let encoded { job.files.save(job.computerId, Self.fileName(id), encoded.data) }
            mailbox.post(job, encoded)
            Task { @MainActor in self?.fileFinished() }
        }
        indexWriter = CoalescedWriter<IndexJob>(io: io) { _, job in
            job.files.save(job.computerId, Self.indexName, job.data)
        }
    }

    /// The chats saved for the active computer, most recently opened first.
    public var chatIds: [String] { entries.map(\.id) }
    /// Bytes on disk for the active computer.
    public var totalBytes: Int { entries.reduce(0) { $0 + $1.bytes } }

    /// Keep chats in `files` (nil: keep none), for `computerId`.
    func use(_ files: TranscriptCache?, computerId: String?) {
        // What was asked for under the old settings is written there, not dropped.
        settle()
        self.files = files
        load(computerId)
    }

    /// Show `computerId`'s saved chats.
    func load(_ computerId: String?) {
        settle()
        epoch += 1
        signatures = [:]
        unsettled = [:]
        self.computerId = computerId
        entries = []
        guard let computerId, let files, let data = files.load(computerId, Self.indexName),
              let v = try? JSONValue.parse(data), v.long("v") == Self.indexVersion else { return }
        entries = (v["chats"]?.array ?? []).compactMap { e in
            guard let id = e.str("id"), let file = e.str("file") else { return nil }
            return Entry(id: id, file: file, openedAt: e.long("openedAt") ?? 0, bytes: Int(e.long("bytes") ?? 0), hash: e.str("hash") ?? "")
        }.sorted { $0.openedAt > $1.openedAt }
    }

    /// The saved copy of `chatId`, if there is one.
    public func saved(_ chatId: String) -> SavedTranscript? {
        if let queued = unsettled[chatId] { return queued.transcript }
        io.waitUntilIdle()
        guard let files, let computerId, let e = entries.first(where: { $0.id == chatId }),
              let data = files.load(computerId, e.file), let t = SavedTranscript.from(try? JSONValue.parse(data)),
              t.session.id == chatId else { return nil }
        return t
    }

    /// The saved copy was opened: it is the most recent now.
    public func touch(_ chatId: String) {
        guard let i = entries.firstIndex(where: { $0.id == chatId }) else { return }
        entries[i].openedAt = now()
        entries.sort { $0.openedAt > $1.openedAt }
        writeIndex()
    }

    /// Keep `session` as the chat's saved copy (the computer just sent it).
    public func save(_ session: Session) {
        guard let files, let computerId else { return }
        let at = now()
        let sig = Self.signature(session)
        // The same chat as last time: only the order changes.
        if signatures[session.id] == sig, let i = entries.firstIndex(where: { $0.id == session.id }) {
            entries[i].openedAt = at
            entries.sort { $0.openedAt > $1.openedAt }
            writeIndex()
            return
        }
        signatures[session.id] = sig
        tokens += 1
        let transcript = SavedTranscript(savedAt: at, session: session)
        unsettled[session.id] = (tokens, transcript)
        writer.submit(session.id, Job(transcript: transcript, files: files, computerId: computerId, limit: maxChatBytes,
                                      token: tokens, removal: removals[session.id] ?? 0, epoch: epoch))
    }

    private func fileFinished() {
        for (job, encoded) in mailbox.take() { written(job, encoded) }
    }

    /// Land every write asked for so far, in the index, before the computer changes.
    private func settle() {
        writer.flushNow()
        io.waitUntilIdle()
        fileFinished()
        indexWriter.flushNow()
        io.waitUntilIdle()
    }

    /// A background write finished (`encoded` is nil when one message was bigger than a
    /// whole chat may be: better none than a misleading part).
    private func written(_ job: Job, _ encoded: (data: Data, hash: String)?) {
        let id = job.transcript.session.id
        if unsettled[id]?.token == job.token { unsettled[id] = nil }
        guard job.epoch == epoch, job.removal == (removals[id] ?? 0), computerId == job.computerId else { return }
        guard let encoded else {
            remove(id)
            return
        }
        let at = job.transcript.savedAt
        entries.removeAll { $0.id == id }
        entries.append(Entry(id: id, file: Self.fileName(id), openedAt: at, bytes: encoded.data.count, hash: encoded.hash))
        entries.sort { $0.openedAt > $1.openedAt }
        evict()
        writeIndex()
    }

    /// The chat is gone (deleted here or on the computer).
    public func remove(_ chatId: String) {
        removals[chatId, default: 0] += 1
        writer.cancel(chatId)
        unsettled[chatId] = nil
        signatures[chatId] = nil
        guard let files, let computerId, let i = entries.firstIndex(where: { $0.id == chatId }) else { return }
        removeFile(files, computerId, entries[i].file)
        entries.remove(at: i)
        writeIndex()
    }

    /// Only chats the computer still has stay (its full list just arrived).
    func keepOnly(_ ids: Set<String>) {
        guard let files, let computerId else { return }
        let gone = entries.filter { !ids.contains($0.id) }
        guard !gone.isEmpty else { return }
        for e in gone {
            removals[e.id, default: 0] += 1
            writer.cancel(e.id)
            unsettled[e.id] = nil
            signatures[e.id] = nil
            removeFile(files, computerId, e.file)
        }
        entries.removeAll { !ids.contains($0.id) }
        writeIndex()
    }

    /// Delete every saved chat in `files` (the setting was turned off, or Forget everything),
    /// including what was still waiting to be written.
    func wipeAll(_ files: TranscriptCache) {
        drop()
        io.waitUntilIdle()
        files.removeAll()
        entries = []
    }

    /// Delete one computer's saved chats (Forget), including what was still waiting.
    func wipeComputer(_ id: String) {
        let own = computerId == id
        if own { drop() }
        io.waitUntilIdle()
        files?.removeComputer(id)
        if own { entries = [] }
    }

    private func drop() {
        epoch += 1
        writer.cancelAll()
        indexWriter.cancelAll()
        unsettled = [:]
        signatures = [:]
    }

    /// Wait for everything saved so far to be on disk.
    public func flush() async {
        await writer.flush()
        await indexWriter.flush()
        await writer.flush()
    }

    /// Hand what is waiting to the background queue now (the app is going to the background).
    public func flushNow() {
        writer.flushNow()
        indexWriter.flushNow()
    }

    /// Removals queue behind the writes before them.
    private func removeFile(_ files: TranscriptCache, _ computerId: String, _ name: String) {
        io.run { files.removeFile(computerId, name) }
    }

    private func evict() {
        guard let files, let computerId else { return }
        var kept: [Entry] = []
        var bytes = 0
        for e in entries {
            if kept.count < maxChats && bytes + e.bytes <= maxBytes {
                kept.append(e)
                bytes += e.bytes
            } else {
                removals[e.id, default: 0] += 1
                signatures[e.id] = nil
                removeFile(files, computerId, e.file)
            }
        }
        entries = kept
    }

    /// The index is small; its bytes are made here and written in the background.
    private func writeIndex() {
        guard let files, let computerId else { return }
        let v: JSONValue = .object([
            "v": .int(Self.indexVersion),
            "chats": .array(entries.map { e in
                .object(["id": .string(e.id), "file": .string(e.file), "openedAt": .int(e.openedAt),
                         "bytes": .int(Int64(e.bytes)), "hash": .string(e.hash)])
            }),
        ])
        indexWriter.submit(computerId, IndexJob(files: files, computerId: computerId, data: Data(v.serialized().utf8)))
    }

    /// What decides whether a chat changed since its last save: the counts, the last
    /// message and the update time, not every message's text.
    nonisolated static func signature(_ s: Session) -> Int {
        var h = Hasher()
        h.combine(s.id); h.combine(s.title); h.combine(s.updatedAt); h.combine(s.omittedMessages)
        h.combine(s.providerId); h.combine(s.modelId); h.combine(s.workspaceId); h.combine(s.mode); h.combine(s.chatType)
        h.combine(s.messages.count)
        h.combine(s.messages.first?.id)
        if let m = s.messages.last {
            h.combine(m.id); h.combine(m.content.utf8.count); h.combine(m.reasoning?.utf8.count)
            h.combine(m.toolCalls.count); h.combine(m.toolResult?.output.utf8.count); h.combine(m.interrupted)
            h.combine(m.imageCount)
        }
        return h.finalize()
    }

    /// The copy as written, within `limit` bytes, and a hash of the chat in
    /// it (not the time) to tell a changed chat from the same one. A longer
    /// chat drops its oldest messages, counted with the ones the computer
    /// already left out. Nil when even the newest message is too big.
    nonisolated static func encode(_ t: SavedTranscript, limit: Int) -> (data: Data, hash: String)? {
        guard case .object(var root) = t.json, case .object(var s)? = root["session"] else { return nil }
        var messages = s["messages"]?.array ?? []
        var omitted = t.session.omittedMessages
        while true {
            s["messages"] = .array(messages)
            s["omittedMessages"] = omitted > 0 ? .int(Int64(omitted)) : nil
            root["session"] = .object(s)
            let data = Data(JSONValue.object(root).serialized().utf8)
            if data.count <= limit { return (data, hash(Data(JSONValue.object(s).serialized().utf8))) }
            guard messages.count > 1 else { return nil }
            let drop = max(1, messages.count / 8)
            messages.removeFirst(drop)
            omitted += drop
        }
    }

    /// FNV-1a, 64 bits, as hex: a file name and a change check, not security.
    nonisolated static func hash(_ data: Data) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in data {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(h, radix: 16)
    }

    /// One file per chat, named from its id (the index keeps the id itself).
    nonisolated static func fileName(_ chatId: String) -> String { "chat-" + hash(Data(chatId.utf8)) }
}
