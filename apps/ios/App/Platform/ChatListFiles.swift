import Foundation
import NekkoKit
import NekkoProtocol

/// The saved chat lists (Settings → Keep the chat list when offline), one
/// small JSON file per paired computer in Application Support. The files are
/// encrypted by the system until the iPhone is first unlocked after a restart
/// (`completeUntilFirstUserAuthentication`, so a launch from a notification still
/// reads them) and are excluded from iCloud and computer backups.
@MainActor
final class ChatListFiles: ChatListCache {
    private let dir: URL

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("ChatLists", isDirectory: true)
    }

    func load(_ computerId: String) -> SavedChatList? {
        guard let data = try? Data(contentsOf: file(computerId)) else { return nil }
        return SavedChatList.from(try? JSONValue.parse(data))
    }

    func save(_ computerId: String, _ list: SavedChatList) {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var url = file(computerId)
            try JSONEncoder().encode(list.json).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        } catch {
            // Nothing to show: the list just isn't there next time the computer is unreachable.
        }
    }

    func remove(_ computerId: String) {
        try? FileManager.default.removeItem(at: file(computerId))
    }

    /// The setting was turned off, or Forget everything: no list stays behind.
    func removeAll() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func file(_ computerId: String) -> URL {
        // Computer ids are generated UUIDs; keep only safe characters regardless.
        let safe = String(computerId.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" })
        return dir.appendingPathComponent("\(safe.isEmpty ? "computer" : safe).json")
    }
}
