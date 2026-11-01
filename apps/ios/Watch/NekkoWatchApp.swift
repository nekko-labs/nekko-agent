import SwiftUI
import WatchConnectivity
import WidgetKit

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
    private(set) var snapshot: StatusSnapshot = WatchStatus.load()

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func take(_ received: StatusSnapshot?) {
        guard let s = received else { return }
        guard s != snapshot else { return }
        snapshot = s
        // Kept in the App Group so the watch face complication shows the same counts.
        WatchStatus.save(s)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchStatus.kind)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let snapshot = StatusSnapshot(watchContext: session.receivedApplicationContext)
        Task { @MainActor in self.take(snapshot) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let snapshot = StatusSnapshot(watchContext: applicationContext)
        Task { @MainActor in self.take(snapshot) }
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
            if let w = snapshot.waitingBesideHeadline {
                Label(w, systemImage: "tray.and.arrow.up").font(.footnote)
            }
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
