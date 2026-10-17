import SwiftUI
import WatchConnectivity

/// The Apple Watch glance: how many chats need you and how many are working on
/// the iPhone's active computer, as the iPhone last saw it. Counts only, never
/// chat titles; approvals still arrive as the iPhone's notifications.
@main
struct NekkoWatchApp: App {
    @State private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            WatchStatusView(snapshot: model.snapshot)
                .onAppear { model.start() }
        }
    }
}

@MainActor
@Observable
final class WatchModel: NSObject, WCSessionDelegate {
    private(set) var snapshot: StatusSnapshot = WatchModel.saved()
    private static let key = "watch.status"

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private static func saved() -> StatusSnapshot {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return .empty }
        return s
    }

    private func take(_ context: [String: Any]) {
        guard let s = StatusSnapshot(watchContext: context) else { return }
        snapshot = s
        if let data = try? JSONEncoder().encode(s) { UserDefaults.standard.set(data, forKey: Self.key) }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor in self.take(context) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.take(applicationContext) }
    }
}

struct WatchStatusView: View {
    let snapshot: StatusSnapshot

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: snapshot.needsYou > 0 ? "hand.raised.fill" : "cat")
                .font(.title2)
                .foregroundStyle(snapshot.needsYou > 0 ? Color.orange : Color.secondary)
                .accessibilityHidden(true)
            Text(snapshot.headline)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            if let computer = snapshot.computer {
                Text(computer).font(.footnote).foregroundStyle(.secondary)
            }
            if snapshot.at != .distantPast {
                Text(snapshot.at, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Checked \(snapshot.at.formatted(.relative(presentation: .named)))")
            } else {
                Text("Open Nekko Agent on your iPhone.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .accessibilityElement(children: .combine)
    }
}
