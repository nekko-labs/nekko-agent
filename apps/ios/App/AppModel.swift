import Foundation
import NekkoKit
import NekkoProtocol
import Observation
import UIKit
import WidgetKit

/// The app's root object: the computers store plus the iOS glue around it
/// (Keychain, lifecycle, network changes, haptics, notifications, Live
/// Activities, push, deep links, the app lock). One per process.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let keychain: KeychainStore
    let prefs: Prefs
    let store: ComputersStore
    let lock: AppLock
    let notifier = Notifier()
    private let activities = RunActivities()
    private let network = NetworkWatcher()
    private var started = false
    private var foreground = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// A pairing link opened from a QR / deep link, waiting for the user's confirmation.
    var pendingLink: PairingLink?
    /// A chat to open (notification tap, Live Activity tap, `nekko-agent://chat/<id>`).
    var openChat: String?
    /// The first message typed on New chat, sent by that chat's screen once it opens.
    var firstMessages: [String: String] = [:]

    init() {
        let keychain = KeychainStore()
        #if DEBUG
        // UI tests start from a fresh install; the Keychain outlives uninstalling the app.
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") { keychain.wipe() }
        #endif
        let prefs = Prefs()
        let deviceName = UIDevice.current.name
        self.keychain = keychain
        self.prefs = prefs
        store = ComputersStore(
            store: keychain,
            makeConnection: { RelayClient(config: $0, transport: URLSessionTransport()) },
            deviceName: { deviceName },
            app: Bundle.main.bundleIdentifier)
        lock = AppLock(enabled: prefs.appLock)
    }

    /// The relay connection opens only after the first unlock (when the lock is
    /// on), or when the user acted on a system surface (notification action,
    /// Live Activity button): `force`.
    func start(force: Bool = false) {
        guard !started, force || !(prefs.appLock && lock.locked) else { return }
        started = true
        notifier.install()
        notifier.onApprove = { [weak self] sid, callId, allow in await self?.answerApproval(sid, callId, allow) }
        notifier.onOpen = { [weak self] sid in self?.openChat = sid }
        IntentRouter.approve = { [weak self] sid, callId, allow in await self?.answerApproval(sid, callId, allow) }
        IntentRouter.stop = { [weak self] sid in await self?.stopChat(sid) }
        activities.enabled = { [weak self] in self?.prefs.liveActivities ?? false }
        activities.hideDetails = { [weak self] in self?.prefs.appLock ?? true }
        activities.onPushToken = { [weak self] sid, token in
            guard let self else { return }
            Task { await self.store.registerActivity(sessionId: sid, token: token) }
        }
        _ = store.subscribe { [weak self] e in self?.onEvent(e) }
        watchWidget()
        network.onChange = { [weak self] in Task { @MainActor in self?.store.reconnect() } }
        network.start()
        store.load(preferredId: prefs.defaultComputer)
        if !store.computers.isEmpty { registerForPush() }
    }

    // MARK: Lifecycle

    func didBecomeActive() {
        foreground = true
        endBackgroundTask()
        if started { store.nudge() }
    }

    func didEnterBackground() {
        foreground = false
        lock.didEnterBackground(enabled: prefs.appLock)
        // A little time to deliver an approval or a finished turn as a notification.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "nekko.relay") { [weak self] in
            Task { @MainActor in self?.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: Home Screen widget

    /// Keeps the widget's snapshot (counts only) in step with the store.
    private func watchWidget() {
        withObservationTracking {
            publishWidget()
        } onChange: { [weak self] in
            Task { @MainActor in self?.watchWidget() }
        }
    }

    private func publishWidget() {
        let snapshot = StatusSnapshot(
            computer: store.active?.name, online: store.conn == .online,
            needsYou: store.needsYouCount, running: store.runningCount, at: .now
        )
        if snapshot.save() { WidgetCenter.shared.reloadTimelines(ofKind: StatusSnapshot.kind) }
    }

    // MARK: Events → haptics, notifications, Live Activities

    private func onEvent(_ e: AgentEvent) {
        let chat = store.summaries.first { $0.id == e.sessionId }
        let computer = store.active
        activities.onEvent(e, chatTitle: chat?.title, computerId: computer?.id ?? "", computerName: computer?.name ?? "Computer")
        switch e {
        case .approvalRequired, .question:
            if foreground, prefs.hapticNeedsYou { Haptics.needsYou() }
        case .done:
            if foreground, prefs.hapticDone { Haptics.done() }
        default:
            break
        }
        // Only the chats the phone lists, and only when out of sight.
        guard !foreground, prefs.notify, let chat else { return }
        notifier.post(e, chatTitle: chat.title.isEmpty ? "Chat" : chat.title, computer: computer?.name ?? "Your computer",
                      hideContent: prefs.appLock)
    }

    /// From a notification action or a Live Activity button: wait for the
    /// connection (the app may have just been woken), then answer.
    func answerApproval(_ sessionId: String, _ callId: String, _ allow: Bool) async {
        // Allowing a tool from outside the app needs an unlocked phone (the
        // notification action asks for it; a Lock Screen button may not).
        if allow && !UIApplication.shared.isProtectedDataAvailable { return }
        start(force: true)
        guard await waitOnline(seconds: 10), let r = try? store.remote() else { return }
        _ = try? await r.call(Channels.toolApprove, [.string(sessionId), .string(callId), .bool(allow)])
        notifier.clear(sessionId: sessionId)
    }

    func stopChat(_ sessionId: String) async {
        start(force: true)
        guard await waitOnline(seconds: 10), let r = try? store.remote() else { return }
        _ = try? await r.call(Channels.chatAbort, [.string(sessionId)])
    }

    private func waitOnline(seconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while store.conn != .online {
            if store.conn == .denied || Date() > deadline { return false }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    // MARK: Pairing, links, push

    /// `nekko-agent-pair:?relay=…` (QR / camera), `https://…/?relay=…` (web
    /// edition link) or `nekko-agent://chat/<id>`.
    func handle(url: URL) {
        if url.scheme == "nekko-agent", url.host == "chat" {
            openChat = url.pathComponents.dropFirst().first
            return
        }
        if let link = Pairing.parse(url.absoluteString) { pendingLink = link }
    }

    /// Validate, then pair. Returns why the link can't be used, or nil.
    func pair(_ link: PairingLink) async -> String? {
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        if let p = RelayRoute.problem(link.relayUrl, simulator: simulator) {
            return RelayRoute.message(p, computer: "Your computer")
        }
        start()
        let id = await store.pair(link)
        if prefs.defaultComputer == nil { prefs.defaultComputer = id }
        if await notifier.requestPermission() { registerForPush() }
        return nil
    }

    func registerForPush() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken: Data) {
        store.setPushToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func forget(_ id: String) {
        store.forget(id)
        if prefs.defaultComputer == id { prefs.defaultComputer = store.activeId }
        prefs.lastModel[id] = nil
        if store.computers.isEmpty { activities.endAll() }
    }

    /// Settings → Forget everything on this iPhone.
    func forgetEverything() {
        for c in store.computers { store.forget(c.id) }
        keychain.wipe()
        activities.endAll()
        prefs.defaultComputer = nil
        prefs.lastModel = [:]
    }

    /// The Tailscale-specific explanation when a tailnet relay can't be reached, or nil.
    var tailnetHint: String? {
        guard let c = store.active, c.route == .tailscale, store.conn == .connecting else { return nil }
        if !Tailnet.isConnected {
            return "Tailscale is off on this iPhone. Open the Tailscale app and connect to your tailnet to reach \(c.name)."
        }
        if store.connDetail != nil {
            return "Tailscale is on, but \(c.relayHost) doesn’t answer. Check that \(c.name) is awake, signed in to the same tailnet, and running its relay."
        }
        return nil
    }
}
