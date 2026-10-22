import Foundation

// Files and logs on the computer, from the phone (IO-33 FA-1, FA-5), as the
// computer projects them for phones (packages/shared/src/phone-files.ts):
// a chat's or saved folder's files (list, search, read; save as a Change
// action, checked against the hash the phone read) and the computer's logs,
// read only and redacted on the computer.

/// The folder a files call works in. A phone names it by id, never by path.
public enum FileRoot: Hashable, Sendable {
    /// A chat's checkout: its worktree when isolated, else its project folder.
    case chat(String)
    /// A saved folder on the computer (`workspace:list`).
    case folder(String)

    public var json: JSONValue {
        switch self {
        case .chat(let id): return ["sessionId": .string(id)]
        case .folder(let id): return ["workspaceId": .string(id)]
        }
    }
}

/// One call into the computer's files or logs, ready to send.
public struct FilesRequest: Equatable, Sendable {
    public let channel: String
    public let args: [JSONValue]

    public init(_ channel: String, _ args: [JSONValue]) {
        self.channel = channel
        self.args = args
    }

    /// Saving is the only Change (`PHONE_CHANGE_CHANNELS`); the rest are reads.
    public var isChange: Bool { Channels.filesChange.contains(channel) }

    public static func list(_ root: FileRoot, _ path: String = "") -> FilesRequest {
        FilesRequest(Channels.filesList, [root.json, .string(path)])
    }

    public static func search(_ root: FileRoot, _ query: String, limit: Int = 50) -> FilesRequest {
        FilesRequest(Channels.filesSearch, [root.json, .string(query), .int(Int64(limit))])
    }

    public static func read(_ root: FileRoot, _ path: String) -> FilesRequest {
        FilesRequest(Channels.filesRead, [root.json, .string(path)])
    }

    /// Replace the file, if it still has the hash the phone read.
    public static func write(_ root: FileRoot, _ path: String, content: String, expectHash: String) -> FilesRequest {
        FilesRequest(Channels.filesWrite, [root.json, .string(path), .string(content), ["expectHash": .string(expectHash)]])
    }

    public static func logs() -> FilesRequest { FilesRequest(Channels.logsList, []) }

    /// A log's tail, or with `query` its matching lines.
    public static func log(_ id: String, query: String? = nil, tailBytes: Int? = nil) -> FilesRequest {
        var o: [String: JSONValue] = [:]
        if let query, !query.isEmpty { o["query"] = .string(query) }
        if let tailBytes { o["tailBytes"] = .int(Int64(tailBytes)) }
        return FilesRequest(Channels.logsRead, [.string(id), .object(o)])
    }
}

/// One entry in a folder.
public struct FileEntry: Equatable, Sendable, Identifiable, Hashable {
    public let name: String
    /// Relative to the folder, `/`-separated.
    public let path: String
    public let dir: Bool
    public let size: Int64?
    public let mtime: Date?
    public let link: Bool
    public var id: String { path }

    public init(name: String, path: String, dir: Bool, size: Int64? = nil, mtime: Date? = nil, link: Bool = false) {
        self.name = name
        self.path = path
        self.dir = dir
        self.size = size
        self.mtime = mtime
        self.link = link
    }
}

/// A folder's listing: folders first, then files.
public struct FileListing: Equatable, Sendable {
    public let path: String
    public let entries: [FileEntry]
    /// More entries than the phone was sent.
    public let truncated: Bool
    public let total: Int
    /// Files left out because they may hold secrets.
    public let hiddenSecrets: Int
    /// Links left out because they lead outside the folder.
    public let hiddenLinks: Int

    public static func from(_ v: JSONValue?) -> FileListing? {
        guard let v, v.object != nil else { return nil }
        let entries: [FileEntry] = (v["entries"]?.array ?? []).compactMap { e in
            guard let path = e.str("path") else { return nil }
            let name = e.str("name") ?? (path as NSString).lastPathComponent
            return FileEntry(name: name, path: path, dir: e.flag("dir"), size: e.long("size"),
                             mtime: e.dbl("mtime").map { Date(timeIntervalSince1970: $0 / 1000) }, link: e.flag("link"))
        }
        return FileListing(path: v.str("path") ?? "", entries: entries, truncated: v.flag("truncated"),
                           total: Int(v.long("total") ?? Int64(entries.count)),
                           hiddenSecrets: Int(v.long("hiddenSecrets") ?? 0), hiddenLinks: Int(v.long("hiddenLinks") ?? 0))
    }
}

/// Files whose name or path matched, best first.
public struct FileSearch: Equatable, Sendable {
    public let hits: [FileEntry]
    public let truncated: Bool
    /// False when the computer stopped looking before the end of a very large folder.
    public let complete: Bool

    public static func from(_ v: JSONValue?) -> FileSearch {
        let hits: [FileEntry] = (v?["hits"]?.array ?? []).compactMap { h in
            guard let path = h.str("path") else { return nil }
            return FileEntry(name: h.str("name") ?? (path as NSString).lastPathComponent, path: path, dir: false)
        }
        return FileSearch(hits: hits, truncated: v?.flag("truncated") ?? false, complete: v?.flag("complete") ?? false)
    }
}

/// A file as the phone shows it.
public struct FileContent: Equatable, Sendable {
    public enum Kind: String, Sendable { case text, image, binary }
    public let path: String
    public let name: String
    public let size: Int64
    public let mtime: Date?
    /// sha256 of the whole file: what a save is checked against.
    public let hash: String?
    public let kind: Kind
    public let text: String?
    /// Only part of the file was sent.
    public let truncated: Bool
    public let language: String?
    public let markdown: Bool
    /// Raw image bytes from the computer's data URL.
    public let image: Data?
    public let mime: String?
    /// Whole UTF-8 text the computer would let a save replace.
    public let editable: Bool

    /// Whether this phone may offer to edit it: whole text with a hash.
    public var canEdit: Bool { editable && !truncated && kind == .text && hash != nil && text != nil }

    /// The text's lines, for numbered display.
    public var lines: [String] {
        guard let text else { return [] }
        var all = text.components(separatedBy: "\n")
        if all.last == "" { all.removeLast() }
        return all
    }

    public static func from(_ v: JSONValue?) -> FileContent? {
        guard let v, let path = v.str("path") else { return nil }
        var image: Data?
        if let url = v.str("imageDataUrl"), url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") {
            image = Data(base64Encoded: String(url[url.index(after: comma)...]))
        }
        return FileContent(path: path, name: v.str("name") ?? (path as NSString).lastPathComponent, size: v.long("size") ?? 0,
                           mtime: v.dbl("mtime").map { Date(timeIntervalSince1970: $0 / 1000) }, hash: v.str("hash"),
                           kind: Kind(rawValue: v.str("kind") ?? "") ?? .binary, text: v.str("content"),
                           truncated: v.flag("truncated"), language: v.str("language"), markdown: v.flag("markdown"),
                           image: image, mime: v.str("mime"), editable: v.flag("editable"))
    }
}

/// What a save came back with.
public enum FileSaveResult: Equatable, Sendable {
    /// Saved: the file's new hash.
    case saved(hash: String)
    /// The file changed on the computer since it was read: its current hash (nil when it is gone).
    case conflict(current: String?)

    public static func from(_ v: JSONValue?) -> FileSaveResult? {
        guard let v, let ok = v["ok"]?.bool else { return nil }
        if ok, let hash = v.str("hash") { return .saved(hash: hash) }
        if !ok, v.str("error") == "conflict" { return .conflict(current: v.str("hash")) }
        return nil
    }
}

/// One of the computer's logs.
public struct LogInfo: Equatable, Sendable, Identifiable, Hashable {
    public enum Kind: String, Sendable { case app, daemon, agent }
    /// `app`, `daemon`, or `agent:<chatId>`.
    public let id: String
    public let title: String
    public let kind: Kind
    public let size: Int64
    public let updatedAt: Date?
    public let sessionId: String?

    public static func list(_ v: JSONValue?) -> [LogInfo] {
        (v?.array ?? []).compactMap { l in
            guard let id = l.str("id") else { return nil }
            return LogInfo(id: id, title: l.str("title") ?? id, kind: Kind(rawValue: l.str("kind") ?? "") ?? .app,
                           size: l.long("size") ?? 0, updatedAt: l.dbl("updatedAt").map { Date(timeIntervalSince1970: $0 / 1000) },
                           sessionId: l.str("sessionId"))
        }
    }
}

/// A log's tail, or the lines that matched a search.
public struct LogText: Equatable, Sendable {
    public struct Match: Equatable, Sendable, Identifiable {
        public let line: Int
        public let text: String
        public var id: Int { line }
    }

    public let id: String
    public let size: Int64
    /// Older lines exist before what was sent.
    public let truncated: Bool
    public let text: String?
    public let query: String?
    public let matches: [Match]
    public let moreMatches: Bool

    public static func from(_ v: JSONValue?) -> LogText? {
        guard let v, let id = v.str("id") else { return nil }
        let matches: [Match] = (v["matches"]?.array ?? []).compactMap { m in
            m.long("line").map { Match(line: Int($0), text: m.str("text") ?? "") }
        }
        return LogText(id: id, size: v.long("size") ?? 0, truncated: v.flag("truncated"), text: v.str("text"), query: v.str("query"),
                       matches: matches, moreMatches: v.flag("moreMatches"))
    }
}

/// The computer's files errors start with a code (`not-found: no such chat`);
/// this says them plainly for the phone.
public enum FilesError {
    static let codes = ["outside-root", "secret-file", "not-found", "not-a-file", "not-a-folder", "no-folder", "binary",
                        "too-large", "bad-request", "io"]

    public static func plain(_ message: String) -> String {
        guard let colon = message.range(of: ": "), codes.contains(String(message[..<colon.lowerBound])) else { return message }
        let code = String(message[..<colon.lowerBound])
        let rest = String(message[colon.upperBound...])
        switch code {
        case "secret-file": return "This file may hold secrets, so it never leaves the computer."
        case "no-folder": return "This chat has no folder on the computer."
        case "not-found": return rest.isEmpty ? "Not found." : rest.prefix(1).uppercased() + rest.dropFirst() + "."
        default: return rest.prefix(1).uppercased() + rest.dropFirst() + "."
        }
    }
}
