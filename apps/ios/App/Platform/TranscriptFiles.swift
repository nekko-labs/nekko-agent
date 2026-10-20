import Foundation
import NekkoKit

/// The chats kept to read offline (Settings → Offline → Keep recent chats to
/// read offline; NekkoKit `SavedTranscripts` decides which and how much). One
/// JSON file per chat plus an index per computer, in Application Support.
/// Like the saved chat lists, the files are encrypted by the system until the
/// iPhone is first unlocked after a restart
/// (`completeUntilFirstUserAuthentication`, so a launch from a notification can
/// still paint a chat) and are excluded from iCloud and computer backups.
/// Forget deletes a computer's files; turning the setting off or Forget
/// everything deletes the folder. Photos are never written.
@MainActor
final class TranscriptFiles: TranscriptCache {
    private let dir: URL

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("Transcripts", isDirectory: true)
    }

    func load(_ computerId: String, _ name: String) -> Data? {
        try? Data(contentsOf: file(computerId, name))
    }

    func save(_ computerId: String, _ name: String, _ data: Data) {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var url = file(computerId, name)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        } catch {
            // Nothing to show: the chat just isn't there to read offline next time.
        }
    }

    func removeFile(_ computerId: String, _ name: String) {
        try? FileManager.default.removeItem(at: file(computerId, name))
    }

    func removeComputer(_ computerId: String) {
        let prefix = safe(computerId) + "."
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for n in names where n.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: dir)
    }

    private func safe(_ s: String) -> String {
        // Computer ids are generated UUIDs and chat file names are hashes; keep only safe characters regardless.
        let kept = String(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" })
        return kept.isEmpty ? "computer" : kept
    }

    private func file(_ computerId: String, _ name: String) -> URL {
        dir.appendingPathComponent("\(safe(computerId)).\(safe(name)).json")
    }
}
