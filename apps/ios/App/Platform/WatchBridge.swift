import Foundation
import WatchConnectivity

/// Sends the widget's snapshot (counts and the computer's name, nothing else)
/// to the Nekko Agent app on a paired Apple Watch. The watch never talks to the
/// computer or the relay and holds no pairing keys; it shows what the iPhone
/// last saw. Application context keeps only the latest value, so a watch that
/// was out of reach gets the current counts when it comes back.
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    private var latest: StatusSnapshot?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(_ snapshot: StatusSnapshot) {
        latest = snapshot
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        try? session.updateApplicationContext(snapshot.watchContext)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Counts saved before the session was ready go out now.
        Task { @MainActor in if let latest = self.latest { self.send(latest) } }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        // The user switched watches: reconnect to the new one.
        session.activate()
    }
}
