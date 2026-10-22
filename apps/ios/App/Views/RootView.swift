import NekkoKit
import NekkoProtocol
import SwiftUI

enum Route: Hashable {
    case chat(String)
    case newChat
    case computers
    case settings
    case pair
    case connection
    case automations
    case usage
    case files
    case logs
    case cloud
    case syncedChat(String)
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    @State private var selected: Route?
    /// First run: step 1 was passed with Continue (this launch).
    @State private var introDone = false
    @Environment(\.horizontalSizeClass) private var size

    var body: some View {
        ZStack {
            content
                // Under the cover the chats must not be readable by VoiceOver either.
                .accessibilityHidden(covered)
            // The app switcher snapshot shows a cover while the lock is on.
            if covered {
                LockView().transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: app.lock.locked)
        .onChange(of: app.lock.locked) { _, locked in if !locked { app.start() } }
        // iPad: a new sidebar pick starts a fresh detail stack (Settings pushed
        // earlier no longer covers it), and another computer drops this one's chat.
        .onChange(of: selected) { _, _ in if size == .regular { path = [] } }
        .onChange(of: store.activeId) { _, _ in
            selected = nil
            path = []
        }
        // Shared from another app: New chat opens with the text, nothing is sent.
        .onChange(of: app.sharedText, initial: true) { _, text in
            if text != nil { open(.newChat) }
        }
        .onChange(of: store.ready, initial: true) { _, _ in
            app.takeShare()
            takeNewChat()
        }
        // The Control Center control: New chat on the active computer, nothing typed.
        .onChange(of: app.newChatRequested, initial: true) { _, _ in takeNewChat() }
        .onChange(of: app.openChat) { _, id in
            guard let id else { return }
            open(.chat(id))
            app.openChat = nil
        }
        // A pairing link opened while locked waits until the app is unlocked.
        .sheet(item: Binding(get: { covered ? nil : app.pendingLink.map(LinkBox.init) }, set: { app.pendingLink = $0?.link })) { box in
            ConfirmPairSheet(link: box.link) { path = [] }
        }
        // First run, step 3: right after the first pairing.
        .fullScreenCover(isPresented: Binding(get: { app.showNotificationStep && !covered }, set: { if !$0 { app.showNotificationStep = false } })) {
            NotificationStepView()
        }
    }

    /// A cold launch from the control waits until the computers are loaded.
    private func takeNewChat() {
        guard app.newChatRequested, store.ready else { return }
        app.newChatRequested = false
        if !store.computers.isEmpty { open(.newChat) }
    }

    private var covered: Bool { app.prefs.appLock && (app.lock.locked || phase != .active) }

    @ViewBuilder private var content: some View {
        if !store.ready && !(app.prefs.appLock && app.lock.locked) {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(palette.paper)
        } else if store.computers.isEmpty {
            NavigationStack {
                if app.prefs.onboarded || introDone { WelcomeView() } else { FirstRunIntroView { introDone = true } }
            }
        } else if size == .regular {
            // iPad and large landscape: chats in the sidebar, the selected one beside it.
            NavigationSplitView {
                ChatsView(path: $path, selection: $selected)
            } detail: {
                NavigationStack(path: $path) {
                    Group {
                        if let selected { destination(selected) } else {
                            ContentUnavailableView("Pick a chat", systemImage: "bubble.left.and.text.bubble.right",
                                                   description: Text("Or start a new one on \(store.active?.name ?? "your computer")."))
                        }
                    }
                    .navigationDestination(for: Route.self) { destination($0) }
                }
                .id(selected)
            }
        } else {
            NavigationStack(path: $path) {
                ChatsView(path: $path)
                    .navigationDestination(for: Route.self) { destination($0) }
            }
        }
    }

    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .chat(let id): ChatView(sessionId: id)
        case .newChat: NewChatView(path: $path, opened: { id in open(.chat(id)) })
        case .computers: ComputersView()
        case .settings: SettingsView()
        case .pair: PairView { path.removeAll() }
        case .connection: ConnectionView()
        case .automations: AutomationsView()
        case .usage: UsageView()
        case .files: FoldersView()
        case .logs: LogsView()
        case .cloud: CloudView()
        case .syncedChat(let id): SyncedChatView(chatId: id)
        }
    }

    /// Show a route: in the split view's detail on iPad, pushed on iPhone.
    private func open(_ r: Route) {
        if size == .regular {
            path = []
            selected = r
        } else {
            path = [r]
        }
    }
}

struct LinkBox: Identifiable {
    let link: PairingLink
    var id: String { link.room + link.relayUrl }
}

/// Shown over everything while the app lock is on.
struct LockView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var prompted = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            CatMark().frame(width: 72, height: 72).foregroundStyle(palette.accent)
            Text("Nekko Agent").font(.title2.weight(.semibold)).foregroundStyle(palette.ink)
            if app.lock.locked && phase == .active {
                Button {
                    Task { await app.lock.unlock() }
                } label: {
                    Label("Unlock", systemImage: "faceid").frame(maxWidth: 220).padding(.vertical, 6).foregroundStyle(palette.onAccent)
                }
                .buttonStyle(.borderedProminent)
                if let e = app.lock.error { Text(e).font(.footnote).foregroundStyle(palette.danger) }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.paper)
        // Ask once per return to the app: the Face ID sheet itself makes the
        // scene inactive and active again, which used to ask again after Cancel.
        .task(id: phase) {
            if phase == .background { prompted = false }
            guard phase == .active, !prompted else { return }
            prompted = true
            await app.lock.unlock()
        }
    }
}

/// The outline Nekko head (same path as the desktop's and Android's mark, simplified).
struct CatMark: View {
    var body: some View {
        Canvas { ctx, size in
            let w = size.width, h = size.height
            var p = Path()
            p.move(to: CGPoint(x: w * 0.14, y: h * 0.86))
            p.addLine(to: CGPoint(x: w * 0.14, y: h * 0.18))
            p.addLine(to: CGPoint(x: w * 0.36, y: h * 0.36))
            p.addQuadCurve(to: CGPoint(x: w * 0.64, y: h * 0.36), control: CGPoint(x: w * 0.5, y: h * 0.30))
            p.addLine(to: CGPoint(x: w * 0.86, y: h * 0.18))
            p.addLine(to: CGPoint(x: w * 0.86, y: h * 0.86))
            p.addArc(center: CGPoint(x: w * 0.5, y: h * 0.86), radius: w * 0.36, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: true)
            p.closeSubpath()
            ctx.stroke(p, with: .foreground, style: StrokeStyle(lineWidth: max(1.5, w / 40), lineCap: .butt, lineJoin: .miter))
        }
        .accessibilityHidden(true)
    }
}

/// The phone and the computer speak different protocol versions (IO-32): which side to update.
struct ProtocolBanner: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if let text = store.protocolCheck.message(computer: store.active?.name ?? "your computer") {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "arrow.triangle.2.circlepath.circle").foregroundStyle(palette.warning)
                    .accessibilityHidden(true)
                Text(text).font(.footnote).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(palette.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("protocol-banner")
        }
    }
}

/// Connection state for the active computer, with the reason when it isn't online.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if let l = line {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: l.icon).foregroundStyle(l.color)
                VStack(alignment: .leading, spacing: 6) {
                    Text(l.text).font(.footnote).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                    // iOS doesn't let an app turn the VPN on; this is the shortest way to the switch (TS-4).
                    if app.offersTailscale {
                        Button("Open Tailscale") { app.openTailscale() }
                            .font(.footnote.weight(.semibold))
                            .accessibilityIdentifier("open-tailscale")
                            .accessibilityHint("Opens the Tailscale app, or the App Store if it isn’t installed.")
                    }
                }
                Spacer(minLength: 0)
                if store.conn == .connecting || store.conn == .offline {
                    Button("Retry") { store.reconnect() }.font(.footnote.weight(.semibold))
                }
            }
            .padding(12)
            .background(l.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            // Retry stays its own button for VoiceOver.
            .accessibilityElement(children: .contain)
        }
    }

    /// The outbox, in a sentence: what is written here goes when the computer is back.
    private var waitingNote: String {
        let n = store.outbox.count
        if n == 0 { return "" }
        return n == 1 ? " 1 prompt waits on this iPhone and goes when it’s back." : " \(n) prompts wait on this iPhone and go when it’s back."
    }

    private var line: (text: String, color: Color, icon: String)? {
        let name = store.active?.name ?? "Your computer"
        switch store.conn {
        case .online, .idle:
            return nil
        case .connecting:
            if let hint = app.tailnetHint { return (hint + waitingNote, palette.warning, "network.slash") }
            return ("Connecting to \(name)…" + (store.connDetail.map { " (\($0))" } ?? "") + waitingNote, palette.running, "arrow.triangle.2.circlepath")
        case .offline:
            return ("\(name) is offline. Open Nekko Agent on it, with Remote access on. This phone keeps trying." + waitingNote, palette.warning, "moon.zzz")
        case .denied:
            let why: String
            switch store.denied {
            case .revoked?, .kicked?: why = "\(name) removed this iPhone."
            case .badCode?: why = "That pairing code was already used or expired."
            case .badKey?: why = "The pairing key no longer matches \(name)."
            case .updateRequired?:
                return ("Update Nekko Agent on this phone: \(name) no longer accepts older apps.", palette.danger, "lock.slash")
            default: why = "\(name) doesn’t know this iPhone."
            }
            return (why + " Pair again from Settings → Remote access on the computer.", palette.danger, "lock.slash")
        }
    }
}
