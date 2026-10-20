import Foundation
import NekkoProtocol

/// The phone's own copy of one computer's chat list, kept while *Keep the
/// chat list when offline* is on (on by default since OF-9). It holds what
/// the list shows and nothing else: each chat's id, title, times, folder and
/// pin, plus the folder names. Never the replies, the first message, the
/// model or anything a chat contains. The app stores it in a file the system
/// encrypts while the iPhone is locked and leaves out of backups.
public struct SavedChatList: Equatable, Sendable {
    public let savedAt: Int64
    public let summaries: [SessionSummary]
    public let folders: [WorkspaceFolder]

    public init(savedAt: Int64, summaries: [SessionSummary], folders: [WorkspaceFolder]) {
        self.savedAt = savedAt
        self.summaries = summaries
        self.folders = folders
    }

    /// Bumped when the shape changes; an older or newer file is ignored, not misread.
    static let version: Int64 = 1

    public var json: JSONValue {
        .object([
            "v": .int(Self.version),
            "savedAt": .int(savedAt),
            "chats": .array(summaries.map { s in
                var o: [String: JSONValue] = ["id": .string(s.id), "title": .string(s.title), "updatedAt": .int(s.updatedAt)]
                if let w = s.workspaceId { o["workspaceId"] = .string(w) }
                if let a = s.archivedAt { o["archivedAt"] = .int(a) }
                if let order = s.order { o["order"] = .double(order) }
                if s.pinned { o["pinned"] = .bool(true) }
                return .object(o)
            }),
            "folders": .array(folders.map { .object(["id": .string($0.id), "name": .string($0.name)]) }),
        ])
    }

    public static func from(_ v: JSONValue?) -> SavedChatList? {
        guard let v, v.long("v") == version, let savedAt = v.long("savedAt") else { return nil }
        return SavedChatList(savedAt: savedAt, summaries: SessionSummary.visible(v["chats"]), folders: WorkspaceFolder.list(v["folders"]))
    }
}

/// Where saved lists live, one per paired computer. The app's is a file per
/// computer; tests use memory.
@MainActor
public protocol ChatListCache: AnyObject {
    func load(_ computerId: String) -> SavedChatList?
    func save(_ computerId: String, _ list: SavedChatList)
    func remove(_ computerId: String)
}

/// The offline switches (*Keep the chat list when offline*, *Keep recent
/// chats to read offline*) are on unless the user turned them off (OF-9,
/// decided 2026-10-19). `stored` is the user's own choice: the app writes it
/// only when the switch is flipped, never at launch, so its presence is the
/// "user chose" record. A new install, or one that never touched the switch,
/// has none and gets it on; a deliberate off (before or after OF-9) stays off.
public enum OfflineSetting {
    public static func isOn(stored: Bool?) -> Bool { stored ?? true }
}
