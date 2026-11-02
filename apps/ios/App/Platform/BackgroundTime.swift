import UIKit

/// A UIKit background task held around one piece of work, so iOS keeps a
/// backgrounded app running until it finishes: begin it, then `end()` it on
/// every path (a `defer` at the call site). When iOS runs out of time first, the
/// expiration handler ends it synchronously, as UIKit requires.
@MainActor
final class BackgroundTime {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(_ name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            // Called on the main thread; the task must be ended before this returns.
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
