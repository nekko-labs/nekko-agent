import NekkoKit
import NekkoProtocol
import SwiftUI

/// How this iPhone reaches the active computer, what to try when it can't, and
/// what has happened since the app started. The log is memory only and holds
/// no rooms, keys or chat content, so it can be copied into a bug report.
/// A computer with several routes (LAN and tailnet, TASKS.md IO-20) shows the
/// one in use; *Check routes* times DNS, TCP and a relay hello on each, and
/// *Share diagnostics* sends the checks and the log as text (IO-21).
struct ConnectionView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var tailnet = Tailnet.isConnected
    @State private var copied = false

    var body: some View {
        List {
            if let c = store.active {
                Section {
                    LabeledContent("Computer", value: c.name)
                    let inUse = store.route ?? c.relayUrl
                    LabeledContent("Route", value: routeName(RelayRoute.of(inUse)))
                        .accessibilityIdentifier("connection-route")
                    LabeledContent("Relay", value: Pairing.relayHost(inUse))
                    if c.routes.count > 1 {
                        LabeledContent("Other routes", value: c.routes.filter { $0 != inUse }
                            .map { "\(routeName(RelayRoute.of($0))) (\(Pairing.relayHost($0)))" }.joined(separator: ", "))
                    }
                    LabeledContent("Status", value: stateName(store.conn))
                    LabeledContent("Tailscale on this iPhone", value: tailnet ? "Connected" : "Off")
                    if let at = store.connectionLog.lastOnline, store.conn != .online {
                        LabeledContent("Last online") { Text(at, format: .relative(presentation: .named)) }
                    }
                } footer: {
                    Text("Messages are end-to-end encrypted on every route; the relay sees only sealed frames.")
                        .foregroundStyle(palette.inkSoft)
                }

                let dialing = store.route ?? c.relayUrl
                let advice = ConnectionAdvice.advise(route: RelayRoute.of(dialing), relayHost: Pairing.relayHost(dialing),
                                                     computer: c.name, state: store.conn,
                                                     denied: store.denied, detail: store.connDetail, tailscaleOn: tailnet)
                if !advice.isEmpty {
                    Section {
                        ForEach(advice, id: \.self) { Label($0, systemImage: "lightbulb").foregroundStyle(palette.ink) }
                        if TailscaleApp.shouldOffer(route: RelayRoute.of(dialing), tailscaleOn: tailnet, state: store.conn) {
                            Button { app.openTailscale() } label: { Label("Open Tailscale", systemImage: "network") }
                                .accessibilityIdentifier("open-tailscale")
                                .accessibilityHint("Opens the Tailscale app, or the App Store if it isn’t installed.")
                        }
                        if store.conn != .denied {
                            Button { store.connect(c.id) } label: { Label("Try again now", systemImage: "arrow.clockwise") }
                        }
                    } header: {
                        header("What to try")
                    }
                }

                Section {
                    ForEach(store.checks) { r in RouteCheckRow(report: r) }
                    Button {
                        Task { await store.runChecks() }
                    } label: {
                        if store.checking {
                            Label("Checking…", systemImage: "hourglass")
                        } else {
                            Label(store.checks.isEmpty ? "Check routes" : "Check again", systemImage: "stethoscope")
                        }
                    }
                    .disabled(store.checking)
                    .accessibilityIdentifier("check-routes")
                    .accessibilityHint("Looks up, connects to and says hello on each of the computer's relay addresses.")
                } header: {
                    header("Checks")
                } footer: {
                    ShareLink(item: store.diagnosticsText(app: appVersion)) {
                        Label("Share diagnostics", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("share-diagnostics")
                    .accessibilityHint("The checks and the log as text: hosts, states and timings, never keys, codes or messages.")
                }

                Section {
                    if store.connectionLog.entries.isEmpty {
                        Text("Nothing yet.").foregroundStyle(palette.inkSoft)
                    }
                    ForEach(store.connectionLog.entries.reversed()) { e in
                        LogRow(entry: e)
                    }
                } header: {
                    header("Since the app started")
                } footer: {
                    Button(copied ? "Copied" : "Copy log") {
                        UIPasteboard.general.string = store.connectionLog.text(relayHost: c.relayHost, route: c.route)
                        copied = true
                    }
                    .disabled(store.connectionLog.entries.isEmpty)
                    .accessibilityHint("Times, states and the relay's host only; no keys or messages.")
                }
            } else {
                Text("Pair a computer first.").foregroundStyle(palette.inkSoft)
            }
        }
        .appBackground()
        .navigationTitle("Connection")
        .onAppear { tailnet = Tailnet.isConnected }
        .onChange(of: phase) { _, p in if p == .active { tailnet = Tailnet.isConnected } }
        .onChange(of: store.conn) { _, _ in tailnet = Tailnet.isConnected }
    }
}

private var appVersion: String {
    let info = Bundle.main.infoDictionary
    let v = info?["CFBundleShortVersionString"] as? String ?? "?"
    let b = info?["CFBundleVersion"] as? String ?? "?"
    return "\(v) (\(b)), iOS \(UIDevice.current.systemVersion)"
}

/// One route's checks: what kind of route, then each step with its time.
private struct RouteCheckRow: View {
    let report: RouteReport
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(routeName(report.kind)) · \(report.host)").foregroundStyle(palette.ink)
            step("Name lookup", report.dns)
            step("Connect", report.tcp)
            step("Relay hello", report.hello)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func step(_ name: String, _ s: ProbeStep?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: s == nil ? "minus.circle" : s!.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(s == nil ? palette.inkSoft : s!.ok ? palette.success : palette.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(name + (s?.ms.map { " · \($0) ms" } ?? "")).font(.footnote).foregroundStyle(palette.ink)
                if let d = s?.detail { Text(d).font(.caption).foregroundStyle(palette.inkSoft) }
                if s == nil { Text("Not run").font(.caption).foregroundStyle(palette.inkSoft) }
            }
        }
    }
}

extension ConnectionView {
    /// Section headers in the palette's secondary ink: the system grey misses contrast on its paper.
    func header(_ text: String) -> some View {
        Text(text).foregroundStyle(palette.inkSoft)
    }
}

private struct LogRow: View {
    let entry: ConnectionLog.Entry
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(stateName(entry.state) + (entry.repeats > 1 ? " ×\(entry.repeats)" : ""))
                    .foregroundStyle(palette.ink)
                if let d = detail { Text(d).font(.footnote).foregroundStyle(palette.inkSoft) }
            }
            Spacer(minLength: 8)
            Text(entry.at, format: .dateTime.hour().minute().second()).font(.footnote.monospacedDigit()).foregroundStyle(palette.inkSoft)
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String? {
        if let d = entry.denied { return "Refused: \(d.rawValue)" }
        return entry.detail
    }
    private var icon: String {
        switch entry.state {
        case .online: "checkmark.circle.fill"
        case .connecting: "arrow.triangle.2.circlepath"
        case .offline: "moon.zzz"
        case .denied: "lock.slash"
        case .idle: "pause.circle"
        }
    }
    private var tint: Color {
        switch entry.state {
        case .online: palette.success
        case .connecting: palette.running
        case .offline: palette.warning
        case .denied: palette.danger
        case .idle: palette.inkSoft
        }
    }
}

func stateName(_ s: RelayState) -> String {
    switch s {
    case .idle: String(localized: "Not connected")
    case .connecting: String(localized: "Connecting")
    case .online: String(localized: "Online")
    case .offline: String(localized: "Computer offline")
    case .denied: String(localized: "Refused")
    }
}
