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
        return .object(o)
    }
}

/// Where saved chats live. The app keeps one file per chat under Application
/// Support (encrypted until first unlock, not backed up); tests use memory.
@MainActor
public protocol TranscriptCache: AnyObject {
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
@MainActor
public final class SavedTranscripts {
    public static let defaultMaxChats = 20
    public static let defaultMaxBytes = 5 * 1024 * 1024
    public static let defaultMaxChatBytes = 1024 * 1024
    static let indexName = "index"
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

    public init(maxChats: Int = defaultMaxChats, maxBytes: Int = defaultMaxBytes, maxChatBytes: Int = defaultMaxChatBytes,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.maxChats = maxChats
        self.maxBytes = maxBytes
        self.maxChatBytes = min(maxChatBytes, maxBytes)
        self.now = now
    }

    /// The chats saved for the active computer, most recently opened first.
    public var chatIds: [String] { entries.map(\.id) }
    /// Bytes on disk for the active computer.
    public var totalBytes: Int { entries.reduce(0) { $0 + $1.bytes } }

    /// Keep chats in `files` (nil: keep none), for `computerId`.
    func use(_ files: TranscriptCache?, computerId: String?) {
        self.files = files
        load(computerId)
    }

    /// Show `computerId`'s saved chats.
    func load(_ computerId: String?) {
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
        guard let encoded = Self.encode(SavedTranscript(savedAt: at, session: session), limit: maxChatBytes) else {
            // One message bigger than a whole chat may be: better none than a misleading part.
            remove(session.id)
            return
        }
        let (data, hash) = (encoded.data, encoded.hash)
        // The same chat as last time: only the order changes.
        let file = Self.fileName(session.id)
        if let i = entries.firstIndex(where: { $0.id == session.id }), entries[i].hash == hash {
            entries[i].openedAt = at
        } else {
            files.save(computerId, file, data)
            entries.removeAll { $0.id == session.id }
            entries.append(Entry(id: session.id, file: file, openedAt: at, bytes: data.count, hash: hash))
        }
        entries.sort { $0.openedAt > $1.openedAt }
        evict()
        writeIndex()
    }

    /// The chat is gone (deleted here or on the computer).
    public func remove(_ chatId: String) {
        guard let files, let computerId, let i = entries.firstIndex(where: { $0.id == chatId }) else { return }
        files.removeFile(computerId, entries[i].file)
        entries.remove(at: i)
        writeIndex()
    }

    /// Only chats the computer still has stay (its full list just arrived).
    func keepOnly(_ ids: Set<String>) {
        guard let files, let computerId else { return }
        let gone = entries.filter { !ids.contains($0.id) }
        guard !gone.isEmpty else { return }
        for e in gone { files.removeFile(computerId, e.file) }
        entries.removeAll { !ids.contains($0.id) }
        writeIndex()
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
                files.removeFile(computerId, e.file)
            }
        }
        entries = kept
    }

    private func writeIndex() {
        guard let files, let computerId else { return }
        let v: JSONValue = .object([
            "v": .int(Self.indexVersion),
            "chats": .array(entries.map { e in
                .object(["id": .string(e.id), "file": .string(e.file), "openedAt": .int(e.openedAt),
                         "bytes": .int(Int64(e.bytes)), "hash": .string(e.hash)])
            }),
        ])
        files.save(computerId, Self.indexName, Data(v.serialized().utf8))
    }

    /// The copy as written, within `limit` bytes, and a hash of the chat in
    /// it (not the time) to tell a changed chat from the same one. A longer
    /// chat drops its oldest messages, counted with the ones the computer
    /// already left out. Nil when even the newest message is too big.
    static func encode(_ t: SavedTranscript, limit: Int) -> (data: Data, hash: String)? {
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
    static func hash(_ data: Data) -> String {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in data {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return String(h, radix: 16)
    }

    /// One file per chat, named from its id (the index keeps the id itself).
    static func fileName(_ chatId: String) -> String { "chat-" + hash(Data(chatId.utf8)) }
}
