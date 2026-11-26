import Foundation
import NekkoKit
import NekkoProtocol

/// The saved chat lists (Settings → Keep the chat list when offline), one
/// small JSON file per paired computer in Application Support. The files are
/// encrypted by the system until the iPhone is first unlocked after a restart
/// (`completeUntilFirstUserAuthentication`, so a launch from a notification still
/// reads them) and are excluded from iCloud and computer backups.
///
/// Saves are coalesced and written on a background queue (#3386): the main thread
/// only files the newest list away, and a burst of list refreshes is one write.
@MainActor
final class ChatListFiles: ChatListCache {
    private let dir: URL
    private let io = BackgroundIO(label: "nekko.chat-lists")
    private let writer: CoalescedWriter<SavedChatList>

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("ChatLists", isDirectory: true)
        self.dir = dir
        writer = CoalescedWriter(io: io) { id, list in Self.write(dir, id, list) }
    }

    func load(_ computerId: String) -> SavedChatList? {
        if let queued = writer.pending(computerId) { return queued }
        io.waitUntilIdle()
        guard let data = try? Data(contentsOf: Self.file(dir, computerId)) else { return nil }
        return SavedChatList.from(try? JSONValue.parse(data))
    }

    func save(_ computerId: String, _ list: SavedChatList) {
        writer.submit(computerId, list)
    }

    func flush() { writer.flushNow() }

    private nonisolated static func write(_ dir: URL, _ computerId: String, _ list: SavedChatList) {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var url = file(dir, computerId)
            try JSONEncoder().encode(list.json).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        } catch {
            // Nothing to show: the list just isn't there next time the computer is unreachable.
        }
    }

    func remove(_ computerId: String) {
        writer.cancel(computerId)
        let url = Self.file(dir, computerId)
        io.run { try? FileManager.default.removeItem(at: url) }
    }

    /// The setting was turned off, or Forget everything: no list stays behind.
    func removeAll() {
        writer.cancelAll()
        let dir = dir
        io.run { try? FileManager.default.removeItem(at: dir) }
    }

    private nonisolated static func file(_ dir: URL, _ computerId: String) -> URL {
        // Computer ids are generated UUIDs; keep only safe characters regardless.
        let safe = String(computerId.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" })
        return dir.appendingPathComponent("\(safe.isEmpty ? "computer" : safe).json")
    }
}
