import NekkoKit
import NekkoProtocol
import SwiftUI

/// One slim row of every paired computer and its connection: a dot and a name,
/// one word when something is wrong, and (tapped) one line with the fix under it.
/// Tailscale leads the row when it is what keeps computers away. Replaces the
/// connection, fleet and protocol banners (design: reports/ios-connection-strip-design.html).
struct ConnectionStrip: View {
    /// Only the items with something to say (Files, Monitors); the chat list shows every computer.
    var problemsOnly = false
    /// Opens the Connection screen; nil leaves Details out.
    var details: (() -> Void)?
    /// Debug fixtures: these computers and this Tailscale state instead of the store's.
    var facts: [ConnectionFacts]? = nil
    var tailscaleOn: Bool? = nil
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var open: String?

    init(problemsOnly: Bool = false, details: (() -> Void)? = nil, facts: [ConnectionFacts]? = nil,
         tailscaleOn: Bool? = nil, open: String? = nil) {
        self.problemsOnly = problemsOnly
        self.details = details
        self.facts = facts
        self.tailscaleOn = tailscaleOn
        _open = State(initialValue: open)
    }

    var body: some View {
        let all = ConnectionNotes.make(facts ?? store.connectionFacts, tailscaleOn: tailscaleOn ?? Tailnet.isConnected) { at in
            Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .omitted, time: .shortened)
        }
        let notes = problemsOnly ? ConnectionNotes.problems(all) : all
        if !notes.isEmpty {
            let shown = notes.first { $0.id == open && $0.opens }
            VStack(alignment: .leading, spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) { ForEach(notes) { item($0, selected: shown?.id == $0.id) } }
                        .padding(.horizontal, 12)
                }
                .scrollClipDisabled()
                if let shown {
                    detail(shown)
                        .transition(.opacity.combined(with: .offset(y: -4)))
                }
            }
            .animation(.easeOut(duration: 0.2), value: shown?.id)
            .animation(.easeOut(duration: 0.2), value: notes)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("connection-strip")
        }
    }

    @ViewBuilder private func item(_ n: ConnectionNote, selected: Bool) -> some View {
        let label = HStack(spacing: 6) {
            if n.isTailscale {
                Image(systemName: "network.slash").font(.caption).foregroundStyle(palette.warning)
            } else {
                dot(n.tone)
                Text(n.name ?? "").foregroundStyle(selected ? palette.ink : palette.inkSoft)
            }
            if let w = n.word {
                Text(w).fontWeight(n.isTailscale ? .medium : .regular).foregroundStyle(color(n.wordTone))
            }
            if n.opens {
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(palette.inkFaint)
                    .rotationEffect(.degrees(selected ? 180 : 0))
            }
        }
        .font(.caption.weight(.medium))
        .lineLimit(1)
        .padding(.horizontal, 8)
        .frame(minHeight: 28)
        .background(selected ? palette.ink.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())

        if n.opens {
            Button { open = selected ? nil : n.id } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel([n.name ?? "Tailscale", n.word].compactMap { $0 }.joined(separator: ", "))
                .accessibilityHint(selected ? "Hides the fix." : "Shows how to fix it.")
                .accessibilityIdentifier("strip.\(n.id)")
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(n.name ?? ""), \(stateWord(n.tone))")
                .accessibilityIdentifier("strip.\(n.id)")
        }
    }

    private func dot(_ tone: ConnectionNote.Tone) -> some View {
        Circle()
            .fill(tone == .waiting || tone == .off ? .clear : color(tone))
            .strokeBorder(tone == .waiting || tone == .off ? color(tone) : .clear, lineWidth: 1.5)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }

    private func detail(_ n: ConnectionNote) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            (Text(n.line ?? "").foregroundStyle(palette.inkSoft)
                + Text(n.tail.map { " " + $0 } ?? "").foregroundStyle(palette.inkFaint))
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            if !n.actions.isEmpty || n.more {
                HStack(spacing: 16) {
                    ForEach(Array(n.actions.enumerated()), id: \.offset) { i, a in action(a, of: n, primary: i == 0) }
                    Spacer(minLength: 0)
                    if n.more {
                        // The safety exits, reachable while the computer can't be (SK-8).
                        Menu { SafetyExitItems() } label: {
                            Image(systemName: "ellipsis").foregroundStyle(palette.inkSoft).frame(minWidth: 28, minHeight: 28)
                        }
                        .accessibilityLabel("More for \(n.name ?? "this computer")")
                        .accessibilityIdentifier("banner.menu")
                    }
                }
                .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func action(_ a: ConnectionNote.Action, of n: ConnectionNote, primary: Bool) -> some View {
        let tint = primary ? palette.accent : palette.ink
        switch a {
        case .retry:
            Button("Retry") {
                if n.id == store.activeId { store.reconnect() } else { store.reconnect(computer: n.id) }
            }
            .foregroundStyle(tint).accessibilityIdentifier("fleet.reconnect")
        case .tryAgain:
            Button("Try again") { store.connect(n.id) }.foregroundStyle(tint)
        case .pairAgain:
            Button("Pair again") { app.openPair = true }.foregroundStyle(tint)
                .accessibilityIdentifier("banner.pair-again")
                .accessibilityHint("Opens the pairing screen so you can scan a fresh code from your computer.")
        case .openTailscale:
            // iOS doesn't let an app turn the VPN on; this is the shortest way to the switch (TS-4).
            Button("Open Tailscale") { app.openTailscale() }.foregroundStyle(tint)
                .accessibilityIdentifier("open-tailscale")
                .accessibilityHint("Opens the Tailscale app, or the App Store if it isn’t installed.")
        case .details:
            if let details { Button("Details") { details() }.foregroundStyle(tint) }
        }
    }

    private func color(_ tone: ConnectionNote.Tone) -> Color {
        switch tone {
        case .ok: palette.success
        case .waiting: palette.running
        case .off: palette.inkFaint
        case .warning: palette.warning
        case .danger: palette.danger
        }
    }

    private func stateWord(_ tone: ConnectionNote.Tone) -> String {
        switch tone {
        case .ok: String(localized: "Online")
        case .waiting: String(localized: "Connecting")
        case .off: String(localized: "Off")
        case .warning, .danger: ""
        }
    }
}

/// Settings: the version difference with the active computer (IO-32), one quiet line that opens.
struct ProtocolBanner: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        if let text = store.protocolCheck.message(computer: store.active?.name ?? "your computer") {
            Button { withAnimation(.easeOut(duration: 0.2)) { open.toggle() } } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.up.circle").foregroundStyle(palette.warning).accessibilityHidden(true)
                        Text(store.protocolCheck == .updatePhone ? "Update this app" : "Update \(store.active?.name ?? "your computer")")
                            .foregroundStyle(palette.ink)
                        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(palette.inkFaint)
                            .rotationEffect(.degrees(open ? 180 : 0))
                        Spacer(minLength: 0)
                    }
                    .font(.footnote.weight(.medium))
                    if open {
                        Text(text).font(.footnote).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                            .transition(.opacity)
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("protocol-banner")
        }
    }
}
