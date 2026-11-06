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
    /// The computer's Monitors: a pane on a folding phone or iPad, the list's last row elsewhere (FD-5).
    case monitors
    /// Settings → Security: the active computer's step-up (SK-6).
    case security
    /// Settings → Live Activities: the card's level, with a preview.
    case liveActivities
    /// Settings → Simple mode: what Simple and Expert show, with a preview.
    case simpleMode
    /// Settings → Models on this iPhone: the providers chats here run on (decision 0050).
    case phoneModels
    /// Connectors: a git provider and project tools, connected on this iPhone itself (decision 0055).
    case connectors
    /// The selected git provider's pull requests, with one-tap prompts (decision 0055).
    case pullRequests
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    @State private var path: [Route] = []
    /// Regular width (an open folding phone, iPad): the two panes (FD-3).
    @State private var panes = PaneHost()
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
            // Another computer became active. Every computer stays connected now
            // (2026-11-04), so what is open stays, except a chat on another computer
            // (its screen talks to the active one). The panes come back as that
            // computer left them, with the chat that made it active in focus.
            .onChange(of: store.activeId) { _, id in
                if let cut = path.firstIndex(where: { r in
                    if case .chat(let chat) = r, let on = store.computerId(ofChat: chat) { return on != id }
                    return false
                }) { path.removeSubrange(cut...) }
                let focused = panes.layout.focusedChatId
                panes.sync(computer: id, prefs: app.prefs)
                if let focused, store.computerId(ofChat: focused) == id, panes.layout.focusedChatId != focused {
                    panes.open(.chat(focused))
                }
            }
            // Closing a folding phone: one column, on the chat that was focused.
            // Opening it again restores the panes as they were.
            .onChange(of: size) { old, new in
                if old == .regular && new == .compact {
                    path = panes.layout.focusedChatId.map { [Route.chat($0)] } ?? []
                }
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
            .onChange(of: app.openSettings) { _, on in
                guard on else { return }
                app.openSettings = false
                open(.settings)
            }
            .onChange(of: app.openPair) { _, on in
                guard on else { return }
                app.openPair = false
                open(.pair)
            }
            .onChange(of: app.openChat) { _, id in
                guard let id else { return }
                // A `?listen=1` for another chat is stale once this one opens.
                if app.listenIn != id { app.listenIn = nil }
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
            // SK-6 / SK-8: the step-up sheet, and the safety exits' confirmations.
            .stepUpSheet()
            .safetyExitDialogs()
    }

    /// A cold launch from the control waits until the computers are loaded.
    private func takeNewChat() {
        guard app.newChatRequested, store.ready else { return }
        app.newChatRequested = false
        if !store.computers.isEmpty || phoneRuns { open(.newChat) }
    }

    /// This iPhone runs chats of its own, so the chat list shows with no computer paired.
    private var phoneRuns: Bool { phone.isSetUp || !phone.chats.isEmpty }

    private var covered: Bool { app.prefs.appLock && (app.lock.locked || phase != .active) }

    private func syncCover() {
        // Before the first unlock the cover is the launch animation, building and holding, so
        // the animation underneath takes over without a seam; after that it is the dissolving cat.
        let lock = LockView(phase: phase, cat: app.lock.everUnlocked, opening: !covered) { cover.opened() }
            .environment(app)
            .modifier(Themed(choice: app.prefs.theme, appearance: store.appearance))
        if covered { cover.show(lock) } else { cover.open(lock) }
    }

    @ViewBuilder private var content: some View {
        if !store.ready && !(app.prefs.appLock && app.lock.locked) {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background { AppBackdrop() }
        } else if store.computers.isEmpty && !phoneRuns {
            NavigationStack {
                if app.prefs.onboarded || introDone { WelcomeView() } else { FirstRunIntroView { introDone = true } }
            }
        } else if size == .regular {
            // An open folding phone, iPad, large landscape: two panes by posture
            // (Chats + Chat until another arrangement is picked).
            PanesView(host: panes)
        } else {
            NavigationStack(path: $path) {
                ChatsView(path: $path)
                    .navigationDestination(for: Route.self) { destination($0) }
            }
        }
    }

    private func destination(_ route: Route) -> some View {
        RouteView(route: route, path: $path, openChat: { id in open(.chat(id)) })
    }

    /// Show a route: in a pane on a regular-width screen, pushed on iPhone.
    private func open(_ r: Route) {
        if size == .regular {
            panes.sync(computer: store.activeId, prefs: app.prefs)
            if let content = PaneHost.content(r) {
                let running = Set(store.activity.compactMap { $0.value == .running || $0.value == .needsYou ? $0.key : nil })
                panes.open(content, running: running)
            } else {
                panes.push(r)
            }
        } else {
            path = [r]
        }
    }
}

/// One route's screen, pushed in the phone's stack or inside a pane.
struct RouteView: View {
    let route: Route
    @Binding var path: [Route]
    /// Show a chat created or picked here (New chat, Monitors).
    var openChat: (String) -> Void

    var body: some View {
        switch route {
        case .chat(let id): ChatScreen(sessionId: id)
        case .newChat: NewChatView(path: $path, opened: openChat)
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
        // Back from the chat returns to Monitors.
        case .monitors: MonitorsView(open: { id in path.append(.chat(id)) })
        case .security: SecuritySettingsView()
        case .liveActivities: LiveActivitySettingsView()
        case .simpleMode: SimpleModeSettingsView()
        case .phoneModels: PhoneModelsView()
        case .connectors: ConnectorsView()
        case .pullRequests: PullRequestsView(path: $path)
        }
    }
}

/// A chat's screen: one on a computer, or one that runs on this iPhone.
struct ChatScreen: View {
    let sessionId: String

    var body: some View {
        if PhoneProviders.isPhoneChat(sessionId) { PhoneChatView(chatId: sessionId) } else { ChatView(sessionId: sessionId) }
    }
}

struct LinkBox: Identifiable {
    let link: PairingLink
    var id: String { link.room + link.relayUrl }
}

/// Hosts the lock cover in a window of its own over the app's, so it hides
/// sheets, alerts and menus as well as the screen under them. Shown at once
/// (the app switcher snapshot is taken as the app leaves); unlocked, its view
/// plays the opening animation's dissolve and then the window goes.
@MainActor
final class CoverWindow {
    /// The scene RootView is in (iPad can have several).
    weak var scene: UIWindowScene?
    private var window: UIWindow?
    /// The view is dissolving away.
    private var opening = false
    /// Each showing, so a half-run dissolve never leaves the next cover see-through.
    private var run = 0

    func show(_ view: some View) {
        if window?.isHidden != false || opening { run += 1 }
        opening = false
        if let window {
            put(view, in: window)
            window.isHidden = false
            return
        }
        guard let scene = scene ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        let host = UIHostingController(rootView: AnyView(view.id(run)))
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
    }

    /// Unlocked: `view` dissolves and calls `opened` when it's gone.
    func open(_ view: some View) {
        guard let window, !window.isHidden, !opening else { return }
        opening = true
        put(view, in: window)
    }

    private func put(_ view: some View, in window: UIWindow) {
        guard let host = window.rootViewController as? UIHostingController<AnyView> else { return }
        host.rootView = AnyView(view.id(run))
        // Coming back from the background, a new root view here is not drawn until
        // something else lays the window out, so Face ID and the dissolve never started.
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
    }

    func opened() {
        guard opening else { return }
        opening = false
        window?.isHidden = true
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

/// Shown over everything while the app lock is on: the opening animation's
/// plum and cat, so the return is one dissolve with Face ID in the middle.
/// Unlock appears only if Face ID was cancelled or failed.
struct LockView: View {
    /// RootView's: the cover's window is not part of the SwiftUI scene, so it
    /// would not see the phase change.
    let phase: ScenePhase
    /// Unlocked: dissolve, then `opened`.
    var opening = false
    var opened: () -> Void = {}
    @Environment(AppModel.self) private var app
    @State private var prompted = false
    /// Fixed for this showing: the first unlock flips `everUnlocked` before the cover goes.
    @State private var cat: Bool

    init(phase: ScenePhase, cat: Bool, opening: Bool = false, opened: @escaping () -> Void = {}) {
        self.phase = phase
        self.opening = opening
        self.opened = opened
        _cat = State(initialValue: cat)
    }

    var body: some View {
        ZStack {
            if cat {
                SplashView(kind: .resume, ready: opening, onDone: opened)
            } else {
                // The launch animation itself, building the cat and holding it: unlocked, the cover
                // goes at once and the same frame underneath (same clock) carries on into the zoom.
                SplashView(ready: false) {}
            }
            if app.lock.locked && phase == .active && prompted && !app.lock.authenticating {
                VStack(spacing: 12) {
                    Spacer()
                    Button {
                        Task { await app.lock.unlock() }
                    } label: {
                        Label("Unlock", systemImage: "faceid").frame(maxWidth: 220).padding(.vertical, 6).foregroundStyle(SplashView.ground)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    if let e = app.lock.error { Text(e).font(.footnote).foregroundStyle(.white).multilineTextAlignment(.center) }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 96)
            }
        }
        // Without the cat there is nothing to dissolve: the opening animation underneath takes over.
        .onChange(of: opening) { _, on in if on && !cat { opened() } }
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

/// The brand mark on its own: the head in the brand plum secondary, with no tile
/// behind it, as the desktop, Android and the opening animation show it. The
/// tiled square is only the Home Screen icon.
struct BrandMark: View {
    static let ink = Color(red: 0x85 / 255, green: 0x4f / 255, blue: 0x6c / 255)

    var body: some View {
        CatMark().foregroundStyle(Self.ink).accessibilityHidden(true)
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

/// The other paired computers in view that can't be reached now (2026-11-04),
/// a line each with Reconnect. Each link keeps trying on its own; the button
/// dials at once. A computer that is only connecting says nothing until it fails.
struct FleetBanner: View {
    /// The computers in view: every paired one (nil), or one.
    let computer: String?
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        ForEach(down, id: \.0.id) { item in row(item.0, item.1) }
    }

    private func row(_ c: Computer, _ peer: Peer) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: peer.conn == .denied ? "lock.slash" : "moon.zzz")
                .foregroundStyle(peer.conn == .denied ? palette.danger : palette.warning)
                .accessibilityHidden(true)
            Text(line(c.name, peer)).font(.footnote).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if peer.conn == .denied {
                Button("Pair again") { app.openPair = true }.font(.footnote.weight(.semibold))
            } else {
                Button("Reconnect") { store.reconnect(computer: c.id) }.font(.footnote.weight(.semibold))
                    .accessibilityIdentifier("fleet.reconnect")
            }
        }
        .padding(12)
        .background((peer.conn == .denied ? palette.danger : palette.warning).opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }

    private var down: [(Computer, Peer)] {
        store.computers.compactMap { c in
            guard computer == nil || computer == c.id, let peer = store.peers[c.id] else { return nil }
            let failing = peer.conn == .offline || peer.conn == .denied || (peer.conn == .connecting && peer.detail != nil)
            return failing ? (c, peer) : nil
        }
    }

    private func line(_ name: String, _ peer: Peer) -> String {
        switch peer.conn {
        case .denied:
            return peer.denied == .badKey || peer.denied == .badCode
                ? String(localized: "The pairing key no longer matches \(name).")
                : String(localized: "\(name) doesn’t know this iPhone any more.")
        case .offline:
            return String(localized: "\(name) is offline. This phone keeps trying.")
        default:
            return String(localized: "Can’t reach \(name) right now. This phone keeps trying.")
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
                    // When the pairing key no longer matches, the only fix is
                    // to scan a fresh code from the computer; push PairView
                    // direct instead of just pointing the user at Settings.
                    if offersPairAgain {
                        Button("Pair again") { app.openPair = true }
                            .font(.footnote.weight(.semibold))
                            .accessibilityIdentifier("banner.pair-again")
                            .accessibilityHint("Opens the pairing screen so you can scan a fresh code from your computer.")
                    }
                }
                Spacer(minLength: 0)
                // Retry won't help when the pair key is bad: hide it so the
                // Pair again button is the obvious next step.
                if (store.conn == .connecting || store.conn == .offline), !offersPairAgain {
                    Button("Retry") { store.reconnect() }.font(.footnote.weight(.semibold))
                } else if store.conn == .denied, store.safetyExit?.computerId == store.activeId, let id = store.activeId {
                    // Remote access turned back on at the computer: dial again.
                    Button("Try again") { store.connect(id) }.font(.footnote.weight(.semibold))
                }
                // The safety exits, reachable while the computer can't be (SK-8).
                Menu {
                    SafetyExitItems()
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(palette.inkSoft)
                }
                .accessibilityLabel("More for \(store.active?.name ?? "this computer")")
                .accessibilityIdentifier("banner.menu")
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

    /// The pairing key no longer matches, or the computer refused the key
    /// outright: pair again is the only fix, so put the button right in the
    /// banner.
    private var offersPairAgain: Bool {
        if store.connDetail == RelayStatus.badPairingKey { return true }
        if store.conn == .denied, store.denied == .badKey { return true }
        return false
    }

    private var line: (text: String, color: Color, icon: String)? {
        let name = store.active?.name ?? "Your computer"
        // This iPhone ended the connection itself (SK-8): say so, not "removed this iPhone".
        if let exit = store.safetyExit, exit.computerId == store.activeId, store.conn != .online {
            let time = Date(timeIntervalSince1970: Double(exit.at) / 1000).formatted(date: .omitted, time: .shortened)
            switch exit.kind {
            case .stoppedRemote:
                return ("You stopped remote access on \(name) from this iPhone at \(time). Turn it on again at the computer, then try again here.",
                        palette.warning, "wifi.slash")
            case .quit:
                return ("You quit Nekko Agent on \(name) from this iPhone at \(time). Open it again at the computer; this phone keeps trying.",
                        palette.warning, "power")
            }
        }
        if store.connDetail == RelayStatus.badPairingKey {
            return ("The pairing key no longer matches \(name). Pair again from Settings → Remote access on the computer." + waitingNote,
                    palette.danger, "lock.slash")
        }
        switch store.conn {
        case .online, .idle:
            return nil
        case .connecting:
            if let hint = app.tailnetHint { return (hint + waitingNote, palette.warning, "network.slash") }
            if store.connDetail == RelayStatus.hostNotFound {
                let host = store.active?.relayHost ?? "The relay"
                return ("Can’t find \(host), the address this iPhone was paired with. On \(name), change how phones connect in Settings → Remote access, then pair again." + waitingNote,
                        palette.danger, "exclamationmark.triangle")
            }
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
