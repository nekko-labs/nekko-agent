import Foundation

/// Where the watch keeps the last snapshot the iPhone sent: the shared App
/// Group, so the watch app and its complication read the same counts. Compiled
/// into the watch app and the watch widget extension only.
enum WatchStatus {
    static let kind = "NekkoWatchStatus"
    static let key = "watch.status"
    /// What the Watch says when asked for a guarded action, such as raising a
    /// chat's mode (SK-6): it has no security key or passkey to answer a
    /// step-up, so the owner confirms on the iPhone. The same words as
    /// `StepUp.watchRefusal` (the Watch doesn't link NekkoProtocol). The Watch
    /// only shows counts today and sends nothing to the computer, so nothing
    /// shows this yet; a Watch action that may be guarded must.
    static let stepUpRefusal = "Confirm on your phone."

    static func load(_ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> StatusSnapshot {
        guard let data = defaults?.data(forKey: key), let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return .empty }
        return s
    }

    static func save(_ s: StatusSnapshot, _ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) {
        if let data = try? JSONEncoder().encode(s) { defaults?.set(data, forKey: key) }
    }
}
