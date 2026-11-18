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
    case customize
    case simpleMode
    /// Settings → Models on this iPhone: the providers chats here run on (decision 0050).
    case phoneModels
    /// Connectors: a git provider and project tools, connected on this iPhone itself (decision 0058).
    case connectors
    /// The selected git provider's pull requests, with one-tap prompts (decision 0058).
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
            // A pairing just worked: celebrate over whatever screen is now underneath.
            .overlay {
                if let id = app.justPaired, !covered {
                    PairSuccessView(computerId: id) { app.justPaired = nil }
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.25), value: app.justPaired)
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
            // Closing a folding phone (or turning a large iPhone back upright): one
            // column, on the chat that was focused, with whatever that pane had
            // pushed (Pair, Settings…) still open on top.
            // Opening it again (or turning a large iPhone sideways) carries the
            // phone's open screens into the panes, so a rotation never closes
            // the screen in use, such as the Pair scanner mid-scan.
            .onChange(of: size) { old, new in
                if old == .regular && new == .compact {
                    let pushed = panes.paths[panes.layout.focusedId] ?? []
                    path = (panes.layout.focusedChatId.map { [Route.chat($0)] } ?? []) + pushed
                } else if old == .compact && new == .regular, !path.isEmpty {
                    let carried = path
                    path = []
                    panes.sync(computer: store.activeId, prefs: app.prefs)
                    for r in carried {
                        if let c = PaneHost.content(r) { panes.open(c) } else { panes.push(r) }
                    }
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
                if app.alwaysAllowIn?.chatId != id { app.alwaysAllowIn = nil }
                open(.chat(id))
                app.openChat = nil
            }
            // A pairing link opened while locked waits until the app is unlocked.
            .sheet(item: Binding(get: { covered ? nil : app.pendingLink.map(LinkBox.init) }, set: { app.pendingLink = $0?.link })) { box in
                ConfirmPairSheet(link: box.link) { path = [] }
            }
            // First run, step 3: right after the first pairing, once its celebration is over.
            // After a Tailscale pairing: the steps that are left, checked live.
            .sheet(item: Binding(get: { app.justPaired == nil && !covered ? app.tailscaleSetup.map(SetupBox.init) : nil },
                                 set: { if $0 == nil { app.tailscaleSetup = nil } })) { box in
                TailscaleSetupView(computerId: box.id) { app.tailscaleSetup = nil }
            }
            .fullScreenCover(isPresented: Binding(get: { app.showNotificationStep && app.justPaired == nil && app.tailscaleSetup == nil && !covered }, set: { if !$0 { app.showNotificationStep = false } })) {
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
        case .customize: CustomizeView()
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
                    .tint(BrandColor.mark)
                    if let e = app.lock.error { Text(e).font(.footnote).foregroundStyle(BrandColor.mark).multilineTextAlignment(.center) }
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

/// The brand mark on its own: the head in the theme's plum accent, with no tile
/// behind it, as the desktop, Android and the opening animation show it. The
/// tiled square is only the Home Screen icon.
struct BrandMark: View {
    @Environment(\.palette) private var palette

    var body: some View {
        CatMark().foregroundStyle(palette.accent).accessibilityHidden(true)
    }
}

/// The computer whose Tailscale setup sheet is showing.
private struct SetupBox: Identifiable { let id: String }
