import SwiftUI
import NekkoKit
import NekkoProtocol

/// Right after pairing over Tailscale (and from Connection, any time): the
/// steps that are left, each checked live, so a beginner knows when they are
/// done instead of guessing why the phone can't reach the computer later.
///
/// 1. Tailscale is on on this iPhone (the tunnel's 100.x address is present).
/// 2. The computer answers (this computer's relay state is online).
/// 3. Keep it on away from home: VPN On Demand in Tailscale, so the phone
///    reaches the computer from anywhere without opening Tailscale first.
///
/// The checks re-run when the app comes back from Tailscale and every couple of
/// seconds while open, so turning Tailscale on shows here without a tap.
struct TailscaleSetupView: View {
    let computerId: String
    var done: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var tailnet = Tailnet.isConnected

    /// This computer's connection, whether or not it is the one in front.
    private var conn: RelayState {
        store.activeId == computerId ? store.conn : store.peers[computerId]?.conn ?? .idle
    }

    private var name: String {
        guard let n = store.computers.first(where: { $0.id == computerId })?.name, n != defaultComputerName else {
            return String(localized: "your computer")
        }
        return n
    }

    private var allSet: Bool { tailnet && conn == .online }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("You paired over Tailscale, a private network between your own devices. Two quick checks and your phone can reach \(name) from anywhere.")
                        .foregroundStyle(palette.inkSoft)
                        .listRowBackground(Color.clear)
                }
                Section {
                    step(1, ok: tailnet,
                         title: tailnet ? "Tailscale is on on this iPhone" : "Turn Tailscale on on this iPhone",
                         detail: tailnet
                            ? "Connected to your tailnet."
                            : "Open the Tailscale app, sign in with the same account as on your computer, and switch it on.")
                    if !tailnet {
                        Button { app.openTailscale() } label: {
                            Label("Open Tailscale", systemImage: "network")
                        }
                        .accessibilityIdentifier("tailscaleSetup.open")
                        .accessibilityHint("Opens the Tailscale app, or the App Store if it isn’t installed.")
                    }
                    step(2, ok: conn == .online,
                         title: conn == .online ? "\(name) answers" : "Waiting for \(name)",
                         detail: computerDetail)
                    step(3, ok: nil,
                         title: "Keep it working away from home",
                         detail: "In Tailscale, turn on VPN On Demand (Settings → VPN On Demand). Then your phone reaches your computer on any Wi-Fi or mobile data, without opening Tailscale first.")
                } header: {
                    SectionHeader("Finish setting up")
                }
                Section {
                    Label("Nekko Cloud will connect your phone from anywhere with nothing to install. It’s coming soon; Tailscale is the way for now.", systemImage: "cloud")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Set up Tailscale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(allSet ? "Done" : "Later", action: done).accessibilityIdentifier("tailscaleSetup.done")
                }
            }
            .background { AppBackdrop() }
        }
        .onAppear { tailnet = Tailnet.isConnected }
        // Back from the Tailscale app: show the new state straight away.
        .onChange(of: phase) { _, p in
            if p == .active {
                tailnet = Tailnet.isConnected
                if conn != .online { store.reconnect(computer: computerId) }
            }
        }
        // Tailscale can come up a moment after the app returns; keep looking while open.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                let now = Tailnet.isConnected
                if now && !tailnet && conn != .online { store.reconnect(computer: computerId) }
                tailnet = now
            }
        }
        .accessibilityIdentifier("tailscaleSetup")
    }

    private var computerDetail: String {
        switch conn {
        case .online: return String(localized: "Your chats and tools are reachable from this phone.")
        case .denied: return String(localized: "The computer turned this phone away. Pair again from Settings → Remote access on the computer.")
        case .connecting, .idle, .offline:
            if !tailnet { return String(localized: "This finishes on its own once Tailscale is on.") }
            return String(localized: "On the computer: keep Nekko Agent open, and make sure Tailscale is on and signed in to the same account.")
        }
    }

    /// One step: a check, a spinner-free dot while waiting, or a number for advice.
    private func step(_ n: Int, ok: Bool?, title: LocalizedStringKey, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(ok == true ? palette.success : palette.surface2).frame(width: 26, height: 26)
                if ok == true {
                    Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(palette.onAccent)
                } else {
                    Text("\(n)").font(.caption.weight(.semibold)).foregroundStyle(palette.inkSoft)
                }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(palette.ink)
                Text(detail).font(.footnote).foregroundStyle(palette.inkSoft)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityValue(ok == true ? Text("Done") : ok == false ? Text("Not done yet") : Text(""))
    }
}
