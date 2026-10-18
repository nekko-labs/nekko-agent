import Foundation

/// Where the watch keeps the last snapshot the iPhone sent: the shared App
/// Group, so the watch app and its complication read the same counts. Compiled
/// into the watch app and the watch widget extension only.
enum WatchStatus {
    static let kind = "NekkoWatchStatus"
    static let key = "watch.status"

    static func load(_ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> StatusSnapshot {
        guard let data = defaults?.data(forKey: key), let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return .empty }
        return s
    }

    static func save(_ s: StatusSnapshot, _ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) {
        if let data = try? JSONEncoder().encode(s) { defaults?.set(data, forKey: key) }
    }
}
