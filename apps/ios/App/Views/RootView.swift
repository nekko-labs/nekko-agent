import NekkoKit
import NekkoProtocol
import SwiftUI

enum Route: Hashable {
    case chat(String)
    case newChat
    case computers
    case settings
    case pair
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    @State private var selected: Route?
    @Environment(\.horizontalSizeClass) private var size

    var body: some View {
        ZStack {
            content
            // The app switcher snapshot shows a cover while the lock is on.
            if app.prefs.appLock && (app.lock.locked || phase != .active) {
                LockView().transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: app.lock.locked)
        .onChange(of: app.lock.locked) { _, locked in if !locked { app.start() } }
        // Shared from another app: New chat opens with the text, nothing is sent.
        .onChange(of: app.sharedText, initial: true) { _, text in
            if text != nil { open(.newChat) }
        }
        .onChange(of: store.ready, initial: true) { _, _ in app.takeShare() }
        .onChange(of: app.openChat) { _, id in
            guard let id else { return }
            open(.chat(id))
            app.openChat = nil
        }
        .sheet(item: Binding(get: { app.pendingLink.map(LinkBox.init) }, set: { app.pendingLink = $0?.link })) { box in
            ConfirmPairSheet(link: box.link) { path = [] }
        }
    }

    @ViewBuilder private var content: some View {
        if !store.ready && !(app.prefs.appLock && app.lock.locked) {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(palette.paper)
        } else if store.computers.isEmpty {
            NavigationStack { WelcomeView() }
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

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            CatMark().frame(width: 72, height: 72).foregroundStyle(palette.accent)
            Text("Nekko Agent").font(.title2.weight(.semibold)).foregroundStyle(palette.ink)
            if app.lock.locked && phase == .active {
                Button {
                    Task { await app.lock.unlock() }
                } label: {
                    Label("Unlock", systemImage: "faceid").frame(maxWidth: 220).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                if let e = app.lock.error { Text(e).font(.footnote).foregroundStyle(palette.danger) }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.paper)
        .task(id: phase) { if phase == .active { await app.lock.unlock() } }
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

/// Connection state for the active computer, with the reason when it isn't online.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if let l = line {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: l.icon).foregroundStyle(l.color)
                Text(l.text).font(.footnote).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if store.conn == .connecting || store.conn == .offline {
                    Button("Retry") { store.reconnect() }.font(.footnote.weight(.semibold))
                }
            }
            .padding(12)
            .background(l.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
        }
    }

    private var line: (text: String, color: Color, icon: String)? {
        let name = store.active?.name ?? "Your computer"
        switch store.conn {
        case .online, .idle:
            return nil
        case .connecting:
            if let hint = app.tailnetHint { return (hint, palette.warning, "network.slash") }
            return ("Connecting to \(name)…" + (store.connDetail.map { " (\($0))" } ?? ""), palette.running, "arrow.triangle.2.circlepath")
        case .offline:
            return ("\(name) is offline. Open Nekko Agent on it, with Remote access on. This phone keeps trying.", palette.warning, "moon.zzz")
        case .denied:
            let why: String
            switch store.denied {
            case .revoked?, .kicked?: why = "\(name) removed this iPhone."
            case .badCode?: why = "That pairing code was already used or expired."
            case .badKey?: why = "The pairing key no longer matches \(name)."
            default: why = "\(name) doesn’t know this iPhone."
            }
            return (why + " Pair again from Settings → Remote access on the computer.", palette.danger, "lock.slash")
        }
    }
}
