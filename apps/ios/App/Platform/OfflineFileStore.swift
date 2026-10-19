import Foundation
import NekkoKit
import NekkoProtocol

/// Drafts and the outbox (NekkoKit `DraftStore`, `Outbox`), two small JSON
/// files per paired computer in Application Support. Like the saved chat
/// lists, the files are encrypted by the system until the iPhone is first
/// unlocked after a restart (`completeUntilFirstUserAuthentication`, so a
/// background refresh can still deliver the outbox) and are excluded from
/// iCloud and computer backups. Forget deletes a computer's files; Forget
/// everything deletes the folder.
@MainActor
final class OfflineFileStore: OfflineFiles {
    private let dir: URL

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("Offline", isDirectory: true)
    }

    func load(_ computerId: String, _ name: String) -> JSONValue? {
        guard let data = try? Data(contentsOf: file(computerId, name)) else { return nil }
        return try? JSONValue.parse(data)
    }

    func save(_ computerId: String, _ name: String, _ value: JSONValue) {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var url = file(computerId, name)
            try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        } catch {
            // Nothing to show here: the in-memory copy stays, and the next change writes again.
        }
    }

    func remove(_ computerId: String) {
        let prefix = safe(computerId) + "."
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for n in names where n.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }

    /// Forget everything: no draft or waiting prompt stays behind.
    func removeAll() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func safe(_ s: String) -> String {
        // Computer ids are generated UUIDs; keep only safe characters regardless.
        let kept = String(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" })
        return kept.isEmpty ? "computer" : kept
    }

    private func file(_ computerId: String, _ name: String) -> URL {
        dir.appendingPathComponent("\(safe(computerId)).\(safe(name)).json")
    }
}
