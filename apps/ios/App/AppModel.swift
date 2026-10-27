import Foundation
import NekkoKit
import NekkoProtocol
import Observation
import UIKit
import UserNotifications
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
    /// Files and loopback pages the agent linked, read for the preview window and cards (#1095).
    let previews: PreviewLoader
    /// Nekko Cloud sign-in and end-to-end encrypted sync (its own Keychain service).
    let cloud: CloudSync
    private let cloudKeychain: KeychainStore
    private let cloudKey: CloudDeviceKey
    let lock: AppLock
    let notifier = Notifier()
    let chatLists = ChatListFiles()
    /// The recent chats kept to read offline (OF-5).
    let transcriptFiles = TranscriptFiles()
    /// Drafts and the outbox, per computer.
    let offlineFiles: OfflineFileStore
    private let activities = RunActivities()
    private let network = NetworkWatcher()
    private var started = false
    private var foreground = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// A pairing link opened from a QR / deep link, waiting for the user's confirmation.
    var pendingLink: PairingLink?
    /// A chat to open (notification tap, Live Activity tap, `nekko-agent://chat/<id>`).
    var openChat: String?
    /// The first message typed on New chat (and its photos), sent by that chat's screen once it opens.
    var firstMessages: [String: UnsentPrompt] = [:]
    /// Text shared from another app (the share extension), waiting for New chat to take it.
    var sharedText: String?
    /// `nekko-agent://new` (the Control Center control): open New chat once.
    var newChatRequested = false
    /// First run, step 3 (IO-31): shown right after the first pairing, where
    /// notification permission is asked.
    var showNotificationStep = false
    /// The step-up sheet's question (SK-6), while the store waits for the owner's answer.
    private(set) var stepUpRequest: StepUpRequest?
    private var stepUpAnswer: CheckedContinuation<StepUpProof?, Never>?
    /// A safety exit waiting for its confirmation (SK-8).
    var safetyAsk: SafetyAsk?
    /// What a safety exit did, said once.
    var safetyNotice: String?
    private let shareInbox = ShareInbox(defaults: UserDefaults(suiteName: StatusSnapshot.appGroup) ?? .standard)

    init() {
        let keychain = KeychainStore()
        #if DEBUG
        // UI tests start from a fresh install; the Keychain outlives uninstalling the app.
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") { keychain.wipe() }
        #endif
        let prefs = Prefs()
        let deviceName = UIDevice.current.name
        let offlineFiles = OfflineFileStore()
        #if DEBUG
        // UI tests start without drafts, waiting prompts or saved chats left from an earlier run.
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") {
            offlineFiles.removeAll()
            ChatListFiles().removeAll()
            TranscriptFiles().removeAll()
        }
        #endif
        self.keychain = keychain
        self.prefs = prefs
        self.offlineFiles = offlineFiles
        let computers = ComputersStore(
            store: keychain,
            makeConnection: { RelayClient(config: $0, transport: URLSessionTransport(), prober: HealthProber()) },
            deviceName: { deviceName },
            app: Bundle.main.bundleIdentifier,
            offlineFiles: offlineFiles)
        // Change actions (IO-33) are signed in the Secure Enclave behind Face ID or the passcode.
        computers.changeSigner = SecureEnclaveChangeSigner(store: keychain)
        store = computers
        previews = PreviewLoader(store: computers)
        let cloudKeychain = KeychainStore(service: "dev.nekkolabs.nekkoagent.cloud")
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") { cloudKeychain.wipe() }
        #endif
        let key = CloudDeviceKey(store: cloudKeychain)
        self.cloudKeychain = cloudKeychain
        cloudKey = key
        cloud = CloudSync(api: Self.cloudURL, secrets: cloudKeychain, files: offlineFiles, deviceLabel: deviceName, key: { try key.get() })
        lock = AppLock(enabled: prefs.appLock)
        #if DEBUG
        // What the share extension leaves behind, without driving another app's share sheet.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-uiTestShare"), i + 1 < args.count { shareInbox.offer(args[i + 1]) }
        // First run's step 3 without pairing a computer first.
        if args.contains("-uiTestNotificationStep") { showNotificationStep = true }
        #endif
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
        // A mode raise the computer wants a security key or a code for (SK-6).
        store.stepUpPrompt = { [weak self] request in await self?.askStepUp(request) }
        store.pushKinds = prefs.pushKinds
        store.onDismiss = { tag in Task { await Notifier.dismissNeedsYou(tag: tag) } }
        WatchBridge.shared.start()
        watchWidget()
        network.onFirst = { [weak self] path in Task { @MainActor in self?.store.networkKnown(path) } }
        network.onChange = { [weak self] path in Task { @MainActor in self?.store.networkChanged(path) } }
        network.start()
        if prefs.keepChatList { store.chatListCache = chatLists }
        if prefs.keepTranscripts { store.transcriptCache = transcriptFiles }
        store.load(preferredId: prefs.defaultComputer)
        if !store.computers.isEmpty { registerForPush() }
        // Paired but never onboarded: closed on the first run's last step (iOS hasn't
        // asked yet: show it again), or paired before the first run existed (done).
        if !prefs.onboarded && !store.computers.isEmpty {
            Task {
                let asked = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus != .notDetermined
                if asked { prefs.onboarded = true } else { showNotificationStep = true }
            }
        }
    }

    // MARK: Lifecycle

    func didBecomeActive() {
        foreground = true
        endBackgroundTask()
        OutboxRefresh.cancel()
        if started { store.nudge() }
        takeShare()
    }

    /// Moves a share from the extension to New chat. It waits while no computer
    /// is paired (it expires on its own); once read it is gone from the App Group.
    func takeShare() {
        guard store.ready, !store.computers.isEmpty, let text = shareInbox.take() else { return }
        sharedText = text
    }

    func didEnterBackground() {
        foreground = false
        lock.didEnterBackground(enabled: prefs.appLock)
        // What is typed is on disk before iOS may end the app.
        store.drafts.flush()
        if !store.outbox.items.isEmpty { OutboxRefresh.schedule() }
        // A little time to deliver an approval or a finished turn as a notification:
        // a healthy socket stays open for the grace (IO-20), then closes before
        // iOS would suspend it; the same background task covers it, no new mode.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "nekko.relay") { [weak self] in
            Task { @MainActor in
                self?.store.suspend()
                self?.endBackgroundTask()
            }
        }
        store.enterBackground(grace: Self.backgroundGrace)
    }

    /// How long a healthy socket outlives an app switch (Orca keeps about as long).
    static let backgroundGrace: TimeInterval = 30

    /// A background refresh: connect, deliver what waits, and ask for another
    /// try if anything is left. True when the outbox is empty.
    func deliverInBackground() async -> Bool {
        // Delivering what the user already wrote is not reading chats: the app lock doesn't hold it.
        start(force: true)
        guard !store.outbox.items.isEmpty else { return true }
        if store.conn != .online { store.reconnect() }
        if await waitOnline(seconds: 20) { await store.outbox.flush() }
        let done = store.outbox.items.isEmpty
        if !done { OutboxRefresh.schedule() }
        return done
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
            needsYou: store.needsYouCount, running: store.runningCount, at: .now,
            waiting: store.outbox.count
        )
        if snapshot.save() {
            WidgetCenter.shared.reloadTimelines(ofKind: StatusSnapshot.kind)
            WatchBridge.shared.send(snapshot)
        }
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
        // Only the chats the phone lists, only when out of sight, and only the kinds switched on.
        guard !foreground, let kind = PushKind.of(e), prefs.wants(kind), let chat else { return }
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
        store.resume()
        guard await waitOnline(seconds: 10), let r = try? store.remote() else { return }
        _ = try? await r.call(Channels.toolApprove, [.string(sessionId), .string(callId), .bool(allow)])
        notifier.clear(sessionId: sessionId)
    }

    func stopChat(_ sessionId: String) async {
        start(force: true)
        store.resume()
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
    /// edition link), `nekko-agent://chat/<id>`, `nekko-agent://new` or `nekko-agent://chats`.
    func handle(url: URL) {
        if url.scheme == "nekko-agent", url.host == "chat" {
            openChat = url.pathComponents.dropFirst().first
            return
        }
        if url.scheme == "nekko-agent", url.host == "new" {
            newChatRequested = true
            return
        }
        // The card's "+N" when it holds more chats than it shows: opening the app is the point.
        if url.scheme == "nekko-agent", url.host == "chats" { return }
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
        if prefs.onboarded {
            if await notifier.requestPermission() { registerForPush() }
        } else {
            // The first run's last step explains notifications before iOS asks.
            showNotificationStep = true
        }
        return nil
    }

    /// First run, step 3: *Allow notifications* (true) or *Not now*. Either way it's done.
    func finishOnboarding(allowNotifications: Bool) async {
        showNotificationStep = false
        prefs.onboarded = true
        if allowNotifications, await notifier.requestPermission() { registerForPush() }
    }

    /// Settings → Notifications: one kind on or off, and the relay asked for only the kinds on.
    func setNotify(_ kind: PushKind, _ on: Bool) {
        switch kind {
        case .needsYou: prefs.notifyNeedsYou = on
        case .finished: prefs.notifyFinished = on
        case .failed: prefs.notifyFailed = on
        case .test: return
        }
        store.pushKinds = prefs.pushKinds
    }

    /// *Send a test notification* (IO-30): through the computer and its relay,
    /// or shown by the app when the relay can't push. Returns what to show under the button.
    func sendTestNotification() async -> (text: String, ok: Bool) {
        guard await notifier.ensurePermission() else {
            return ("Notifications are off for Nekko Agent. Turn them on in the iPhone’s Settings → Notifications.", false)
        }
        registerForPush()
        let name = store.active?.name ?? "Your computer"
        do {
            let result = try await store.sendTestNotification()
            if case .local = result { notifier.postTest(computer: name) }
            return (result.message(computer: name, relayHost: store.active?.relayHost ?? "the relay"), true)
        } catch {
            return ("Couldn’t reach \(name): \(error.localizedDescription)", false)
        }
    }

    func registerForPush() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken: Data) {
        store.setPushToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    // MARK: Step-up and safety exits (SK-6, SK-8)

    /// Show the step-up sheet and wait for the owner: an answer, or nil on
    /// Cancel. A question still open is cancelled first.
    func askStepUp(_ request: StepUpRequest) async -> StepUpProof? {
        answerStepUp(nil)
        return await withCheckedContinuation { (cont: CheckedContinuation<StepUpProof?, Never>) in
            stepUpAnswer = cont
            stepUpRequest = request
        }
    }

    func answerStepUp(_ proof: StepUpProof?) {
        let cont = stepUpAnswer
        stepUpAnswer = nil
        stepUpRequest = nil
        cont?.resume(returning: proof)
    }

    /// *Stop remote access on the computer*: the banner says what happened.
    func stopRemoteAccess() async {
        do {
            try await store.stopRemoteAccess()
        } catch {
            safetyNotice = error.localizedDescription
        }
    }

    /// *Quit Nekko Agent on the computer*, after its confirm sheet.
    func quitComputer() async {
        do {
            try await store.quitComputer()
        } catch {
            safetyNotice = error.localizedDescription
        }
    }

    /// *Sign out this phone*: the computer is told now or on the next
    /// connection, and this iPhone forgets it as *Forget* does.
    func signOutThisPhone(_ id: String) async {
        let name = store.computers.first { $0.id == id }?.name ?? "your computer"
        let heard = await store.signOut(id)
        forgotten(id)
        safetyNotice = heard
            ? "Signed out of \(name). To use it from this iPhone again, pair with a new code from the computer."
            : "Signed out of \(name) on this iPhone. \(name) is told the next time this iPhone reaches it."
    }

    func forget(_ id: String) {
        store.forget(id)
        forgotten(id)
    }

    /// The app's own state for a computer that is gone from the list.
    private func forgotten(_ id: String) {
        if prefs.defaultComputer == id { prefs.defaultComputer = store.activeId }
        prefs.lastModel[id] = nil
        if store.computers.isEmpty { activities.endAll() }
    }

    /// Settings → Keep the chat list when offline. Off deletes every saved list.
    func setKeepChatList(_ on: Bool) {
        prefs.keepChatList = on
        store.chatListCache = on ? chatLists : nil
        if !on { chatLists.removeAll() }
    }

    /// Settings → Keep recent chats to read offline. Off deletes every saved chat.
    func setKeepTranscripts(_ on: Bool) {
        prefs.keepTranscripts = on
        store.transcriptCache = on ? transcriptFiles : nil
        if !on { transcriptFiles.removeAll() }
    }

    /// Settings → Forget everything on this iPhone.
    func forgetEverything() {
        for c in store.computers { store.forget(c.id) }
        cloud.forgetAll()
        cloudKey.forget()
        cloudKeychain.wipe()
        chatLists.removeAll()
        transcriptFiles.removeAll()
        offlineFiles.removeAll()
        OutboxRefresh.cancel()
        keychain.wipe()
        activities.endAll()
        prefs.defaultComputer = nil
        prefs.lastModel = [:]
    }

    /// Nekko Cloud: `NekkoCloudURL` in Info.plist, or `-cloudAPI <url>` (debug builds, for the local dev stack).
    static var cloudURL: URL {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-cloudAPI"), i + 1 < args.count, let u = URL(string: args[i + 1]) { return u }
        #endif
        let configured = Bundle.main.object(forInfoDictionaryKey: "NekkoCloudURL") as? String
        return URL(string: configured ?? "") ?? URL(string: "https://nekko-agent-api.fly.dev")!
    }

    /// *Send feedback → Quick note* (#1004): to Nekko Cloud, never through a
    /// computer, and with no credentials (not the Cloud sign-in, not a pairing key).
    /// `info` is nil unless *Include app info* is on.
    func sendFeedback(_ message: String, info: Feedback.AppInfo?) async -> Feedback.Outcome {
        await Feedback.send(message: message, info: info, api: Self.cloudURL)
    }

    /// Offer *Open Tailscale* (TS-4): the active computer is on the tailnet and
    /// Tailscale is off on this iPhone, so that is the switch to flip.
    var offersTailscale: Bool {
        guard let c = store.active else { return false }
        return TailscaleApp.shouldOffer(route: c.route, tailscaleOn: Tailnet.isConnected, state: store.conn)
    }

    /// The Tailscale app, or its App Store page when it isn’t installed.
    func openTailscale() {
        Self.openTailscale(canOpen: { UIApplication.shared.canOpenURL($0) }, open: { UIApplication.shared.open($0) })
    }

    /// What *Open Tailscale* opens; the app tests drive it with the real `canOpenURL`.
    @discardableResult
    nonisolated static func openTailscale(canOpen: (URL) -> Bool, open: (URL) -> Void) -> URL {
        TailscaleApp.open(canOpen: canOpen, open: open)
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
