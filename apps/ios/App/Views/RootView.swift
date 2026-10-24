import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

enum Route: Hashable {
    case chat(String)
    case newChat
    case computers
    /// One paired computer's page: round trip, models, providers, hardware, connection.
    case computer(String)
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

    /// The lock cover's own window, above sheets and alerts.
    @State private var cover = CoverWindow()

    var body: some View {
        content
            // Under the cover the chats must not be readable by VoiceOver either.
            .accessibilityHidden(covered)
            // The app switcher snapshot shows a cover while the lock is on. It is a
            // window over this one rather than a view in it: a view here is drawn
            // under an open sheet (Terminals, Files), which stayed readable.
            .background(SceneReader { cover.scene = $0 })
            .onChange(of: covered, initial: true) { _, _ in syncCover() }
            .onChange(of: phase) { _, _ in syncCover() }
            .onChange(of: app.prefs.theme) { _, _ in syncCover() }
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

    private func syncCover() {
        guard covered else { return cover.hide() }
        cover.show(LockView(phase: phase)
            .environment(app)
            .modifier(Themed(choice: app.prefs.theme, appearance: store.appearance)))
    }

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
        case .computer(let id): ComputerDetailView(computerId: id)
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

/// Hosts the lock cover in a window of its own over the app's, so it hides
/// sheets, alerts and menus as well as the screen under them. Shown at once
/// (the app switcher snapshot is taken as the app leaves), faded out.
@MainActor
final class CoverWindow {
    /// The scene RootView is in (iPad can have several).
    weak var scene: UIWindowScene?
    private var window: UIWindow?

    func show(_ view: some View) {
        if let window, let host = window.rootViewController as? UIHostingController<AnyView> {
            host.rootView = AnyView(view)
            window.layer.removeAllAnimations()
            window.alpha = 1
            window.isHidden = false
            return
        }
        guard let scene = scene ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        let host = UIHostingController(rootView: AnyView(view))
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
    }

    func hide() {
        guard let window, !window.isHidden else { return }
        UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            window.alpha = 0
        } completion: { done in
            if done { window.isHidden = true }
        }
    }
}

/// Reports the window scene a view is in.
struct SceneReader: UIViewRepresentable {
    let found: (UIWindowScene) -> Void

    func makeUIView(context: Context) -> Probe {
        let v = Probe()
        v.found = found
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ uiView: Probe, context: Context) {}

    final class Probe: UIView {
        var found: ((UIWindowScene) -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene { found?(scene) }
        }
    }
}

/// Shown over everything while the app lock is on, on the app's own background.
struct LockView: View {
    /// RootView's: the cover's window is not part of the SwiftUI scene, so it
    /// would not see the phase change.
    let phase: ScenePhase
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var prompted = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            BrandMark().frame(width: 88, height: 88)
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
        .background(palette.paper.ignoresSafeArea())
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

/// The Nekko head, the brand mark: the same path as the app icon and the
/// opening animation (BRAND_HEAD), filled in the foreground style.
struct CatMark: View {
    private static let head = SVGPath.parse(SplashCells.brandHead)

    var body: some View {
        Canvas { ctx, size in
            let b = Self.head.boundingRect
            let k = min(size.width / b.width, size.height / b.height)
            let place = CGAffineTransform(translationX: (size.width - b.width * k) / 2 - b.minX * k,
                                          y: (size.height - b.height * k) / 2 - b.minY * k)
                .scaledBy(x: k, y: k)
            ctx.fill(Self.head.applying(place), with: .foreground, style: FillStyle(eoFill: true))
        }
        .accessibilityHidden(true)
    }
}

/// The brand mark on its own: the head in the brand lavender, with no tile
/// behind it, as the desktop, Android and the opening animation show it. The
/// tiled square is only the Home Screen icon.
struct BrandMark: View {
    static let lavender = Color(red: 0x9d / 255, green: 0x8c / 255, blue: 0xe6 / 255)

    var body: some View {
        CatMark().foregroundStyle(Self.lavender).accessibilityHidden(true)
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
