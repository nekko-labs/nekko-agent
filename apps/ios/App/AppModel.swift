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
    /// This iPhone as a place chats run, on its own cloud providers (decision 0050).
    let phone: PhoneChats
    /// GitHub, Linear, Jira and the rest, connected on this iPhone itself (decision 0058).
    let connectors: ConnectorsModel
    private let connectorKeychain: KeychainStore
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
    /// The card's mic: its own microphone use, apart from any composer's (they share one microphone).
    private let cardDictation = Dictation()
    private let talker = NekkoVoiceRunner()
    private let voiceDispatcher = NekkoVoiceDispatcher()
    private var voiceComputerId: String?
    /// Made in `start()`, with its handlers.
    private var network: NetworkWatcher?
    private var started = false
    private var foreground = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// A pairing link opened from a QR / deep link, waiting for the user's confirmation.
    var pendingLink: PairingLink?
    /// A chat to open (notification tap, Live Activity tap, `nekko-agent://chat/<id>`).
    var openChat: String?
    /// `nekko-agent://chat/<id>?listen=1` (the card's mic on iOS 17): that chat's composer starts listening once.
    var listenIn: String?
    /// `nekko-agent://chat/<id>?alwaysAllow=<call id>` (the notification's or the
    /// Live Activity's "Always allow this tool"): that chat's approval card runs
    /// its own "Always allow" once, for that call only.
    var alwaysAllowIn: AlwaysAllowRequest?
    struct AlwaysAllowRequest: Equatable { var chatId: String; var callId: String }
    /// The first message typed on New chat (and its photos), sent by that chat's screen once it opens.
    var firstMessages: [String: UnsentPrompt] = [:]
    /// Text shared from another app (the share extension), waiting for New chat to take it.
    var sharedText: String?
    /// `nekko-agent://new` (the Control Center control): open New chat once.
    var newChatRequested = false
    /// "Nekko, open settings" from a chat's dictation: show Settings once.
    var openSettings = false
    /// A tap on the banner's *Pair again* when the pairing key no longer
    /// matches: push PairView once so the user can rescan the code without
    /// digging through Settings.
    var openPair = false
    /// First run, step 3 (IO-31): shown right after the first pairing, where
    /// notification permission is asked.
    var showNotificationStep = false
    /// The computer that was just paired: the celebration shows over everything
    /// until it is dismissed (PairSuccessView), then the first run goes on.
    var justPaired: String?
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
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset"), !NativeFixtureRoute.isolated { keychain.wipe() }
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
            offlineFiles: offlineFiles,
            // Every paired computer stays connected, for the chat list across all of them (2026-11-04).
            stayConnected: true)
        // Change actions (IO-33) are signed in the Secure Enclave behind Face ID or the passcode.
        computers.changeSigner = SecureEnclaveChangeSigner(store: keychain)
        // Every relay HELLO is signed with this iPhone's device key (decision 0036), without asking.
        computers.helloSigner = SecureEnclaveHelloSigner(store: keychain)
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
        // Its keys have a Keychain service of their own, apart from the pairing keys.
        let phoneKeychain = KeychainStore(service: "dev.nekkolabs.nekkoagent.phone-providers")
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") { phoneKeychain.wipe() }
        #endif
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestPhoneProvider") {
            // A provider that answers inside the simulator, with no network or real key.
            let fixture = PhoneChats(secrets: phoneKeychain, files: offlineFiles, http: FixturePhoneHTTP())
            if fixture.providers.isEmpty { _ = try? fixture.add(kind: "anthropic", label: "Fixture Claude", baseUrl: nil, key: "fixture-key") }
            phone = fixture
        } else {
            phone = PhoneChats(secrets: phoneKeychain, files: offlineFiles, http: URLSessionPhoneHTTP())
        }
        #else
        phone = PhoneChats(secrets: phoneKeychain, files: offlineFiles, http: URLSessionPhoneHTTP())
        #endif
        // Connector tokens have a Keychain service of their own too (decision 0058).
        let connectorKeychain = KeychainStore(service: "dev.nekkolabs.nekkoagent.phone-connectors")
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") { connectorKeychain.wipe() }
        #endif
        self.connectorKeychain = connectorKeychain
        connectors = ConnectorsModel(secrets: connectorKeychain, files: offlineFiles, http: URLSessionPhoneHTTP())
        lock = AppLock(enabled: prefs.appLock)
        #if DEBUG
        // What the share extension leaves behind, without driving another app's share sheet.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-uiTestShare"), i + 1 < args.count { shareInbox.offer(args[i + 1]) }
        // First run's step 3 without pairing a computer first.
        if args.contains("-uiTestNotificationStep") { showNotificationStep = true }
        // The pairing celebration without pairing a computer first.
        if args.contains("-uiTestPairSuccess") { justPaired = "ui-test" }
        #endif
        if NativeFixtureRoute.isolated { return }
        // Here, not in `start()`: a tap on the card can launch the app in the
        // background, locked, and the card needs no connection to answer it.
        activities.level = { [weak self] in self?.prefs.liveActivityLevel ?? .none }
        activities.source = { [weak self] in
            guard let self, self.store.summariesLoaded, let c = self.store.active else { return nil }
            return .init(summaries: self.store.summaries, activity: self.store.activity, computerId: c.id, computerName: c.name)
        }
        // The computer builds the same card for the relay to push: it hears these too.
        IntentRouter.focus = { [weak self] sid in await self?.focusCard(sid) }
        IntentRouter.dismiss = { [weak self] sid in
            self?.activities.dismiss(sid)
            await self?.tellCard(dismiss: sid)
        }
        wireTalk()
        activities.onCardToken = { [weak self] token in self?.cardTokenArrived(token) }
        SystemCard.watch(adopt: { [weak self] card in self?.activities.adopt(card) },
                         startToken: { [weak self] token in self?.store.cardStartToken = token })
        #if DEBUG
        // Once on screen: ActivityKit starts a card only from the foreground.
        if ProcessInfo.processInfo.arguments.contains("-uiTestLiveCard") {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                self?.activities.showSample(.sample)
            }
        }
        #endif
        watchCard()
        watchCardLevel()
    }

    /// The relay connection opens only after the first unlock (when the lock is
    /// on), or when the user acted on a system surface (notification action,
    /// Live Activity button): `force`.
    func start(force: Bool = false) {
        guard !NativeFixtureRoute.isolated else { return }
        guard !started, force || !(prefs.appLock && lock.locked) else { return }
        started = true
        notifier.install()
        notifier.onApprove = { [weak self] sid, callId, allow in await self?.answerApproval(sid, callId, allow) }
        notifier.onOpen = { [weak self] sid in self?.openChat = sid }
        notifier.onAlwaysAllow = { [weak self] sid, callId in self?.handle(url: LiveCardView.alwaysAllowURL(sid, callId: callId)) }
        IntentRouter.approve = { [weak self] sid, callId, allow in await self?.answerApproval(sid, callId, allow) }
        IntentRouter.stop = { [weak self] sid in await self?.stopChat(sid) }
        store.onComputerEvent = { [weak self] id, e in self?.onEvent(e, computerId: id) }
        notifier.onFocusComputer = { [weak self] id in
            guard let self, id != self.store.activeId, self.store.computers.contains(where: { $0.id == id }) else { return }
            self.store.connect(id)
        }
        notifier.onOpenTag = { [weak self] tag in
            guard let self, let chat = self.store.chats(on: nil).first(where: { E2E.activityTag($0.id) == tag }) else { return }
            self.store.focus(chat: chat.id)
            self.openChat = chat.id
        }
        notifier.onRemote = { [weak self] info in self?.receivedRemoteNotification(info) }
        notifier.wants = { [weak self] kind in kind == .test || self?.prefs.wants(kind) == true }
        notifier.badgeCount = { [weak self] in
            guard let self else { return nil }
            return self.prefs.notifyNeedsYou ? self.store.attentionCount : 0
        }
        watchBadge()
        Task { await refreshNotificationPermission() }
        // A mode raise the computer wants a security key or a code for (SK-6).
        store.stepUpPrompt = { [weak self] request in await self?.askStepUp(request) }
        store.pushKinds = [] // Permission is reconciled asynchronously before enrollment.
        store.onDismiss = { tag in Task { await Notifier.dismissNeedsYou(tag: tag) } }
        WatchBridge.shared.start()
        watchWidget()
        let network = NetworkWatcher(
            onFirst: { [weak self] path in Task { @MainActor in self?.store.networkKnown(path) } },
            onChange: { [weak self] path in Task { @MainActor in self?.store.networkChanged(path) } })
        network.start()
        self.network = network
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
        guard !NativeFixtureRoute.isolated else { return }
        foreground = true
        endBackgroundTask()
        OutboxRefresh.cancel()
        if started {
            store.nudge()
            Task { await refreshNotificationPermission() }
        }
        takeShare()
    }

    /// Moves a share from the extension to New chat. It waits while no computer
    /// is paired (it expires on its own); once read it is gone from the App Group.
    func takeShare() {
        guard store.ready, !store.computers.isEmpty, let text = shareInbox.take() else { return }
        sharedText = text
    }

    func didEnterBackground() {
        guard !NativeFixtureRoute.isolated else { return }
        foreground = false
        // A `?listen=1` not taken by now is stale: listening never starts later by itself.
        listenIn = nil
        // Nor does an "Always allow" left untaken run later by itself.
        alwaysAllowIn = nil
        lock.didEnterBackground(enabled: prefs.appLock)
        // What is typed is on disk before iOS may end the app.
        store.drafts.flush()
        if !store.outbox.items.isEmpty { OutboxRefresh.schedule() }
        // A little time to deliver an approval or a finished turn as a notification:
        // a healthy socket stays open for the grace (IO-20), then closes before
        // iOS would suspend it; the same background task covers it, no new mode.
        // UIKit calls the expiration handler on the main thread and needs the task
        // ended before it returns, or it ends the app: no hop, no Task.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "nekko.relay") { [weak self] in
            MainActor.assumeIsolated {
                Log.background.notice("Background time ran out: suspending the relay connection")
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
        let waiting = store.outbox.items.count
        if store.conn != .online { store.reconnect() }
        let online = await waitOnline(seconds: 20)
        if online { await store.outbox.flush() }
        let done = store.outbox.items.isEmpty
        Log.background.info("Background delivery: \(waiting, privacy: .public) waiting, online \(online, privacy: .public), \(self.store.outbox.items.count, privacy: .public) left")
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

    // MARK: Live Activity card

    /// Rebuilds the card whenever the chat list, who is running, the computer or the level changes.
    private func focusCard(_ sid: String) async {
        activities.focus(sid)
        await tellCard(focus: sid)
    }

    /// A tap on the card, from a phone that may be suspended or locked: wait for
    /// the connection (as `stopChat` does), so the next push does not undo it.
    private func tellCard(focus: String? = nil, dismiss: String? = nil) async {
        start(force: true)
        store.resume()
        guard await waitOnline(seconds: 10) else { return }
        await store.cardAction(focus: focus, dismiss: dismiss)
    }

    private func voiceScopeAllowed(_ id: String) -> Bool {
        activities.card?.attributes.computerId == id &&
        NekkoVoiceScope.permits(computerId: id, activeId: store.activeId, state: store.state(of: id))
    }

    /// Authenticated app-wide voice. Never routes plain speech to focusId and never
    /// publishes the captured transcript. Delivery is distinct from completion.
    private func wireTalk() {
        talker.capture = { [weak self] in
            guard let self, let id = self.voiceComputerId,
                  self.voiceScopeAllowed(id) else { throw CancellationError() }
            self.start(force: true)
            self.store.resume()
            return try await self.cardDictation.captureOnce(store: self.store, computerId: id)
        }
        talker.finish = { [weak self] in self?.cardDictation.stopListening() }
        talker.discard = { [weak self] in self?.cardDictation.discard() }
        talker.onCancel = { [weak self] in self?.voiceDispatcher.cancel() }
        talker.routeWithCommit = { [weak self] text, permit in
            guard let self, let id = self.voiceComputerId, permit.isCurrent,
                  self.voiceScopeAllowed(id),
                  let card = self.activities.card, card.attributes.computerId == id else {
                return "Not sent. Card scope changed. Open app."
            }
            let loaded = id == self.store.activeId ? self.store.summariesLoaded : self.store.peers[id]?.loaded == true
            let context = NekkoVoiceDispatcher.Context(
                computerId: id, computerName: card.attributes.computerName,
                online: self.store.state(of: id) == .online, loaded: loaded,
                card: card.state,
                targets: self.store.chats(on: id).filter { !$0.archived }.map { .init(id: $0.id, name: $0.title) })
            switch self.voiceDispatcher.dispatch(text, context: context) {
            case .message(let reply): return reply
            case .send(let computerId, let sid, let message):
                // Outbox is active-computer scoped. Do not change the user's selection
                // or accidentally enqueue to another computer during a suspension.
                guard self.store.activeId == computerId else {
                    return "Not sent. Open app on this computer to send."
                }
                let confirmedName = context.targets.first { $0.id == sid }?.name
                let delivered = try await CardVoiceDelivery.send(
                    outbox: self.store.outbox, sessionId: sid, text: message, permit: permit,
                    waitOnline: { await self.waitOnline(seconds: 10) },
                    allowed: {
                        NekkoVoiceScope.permitsDelivery(
                            computerId: computerId, activeId: self.store.activeId,
                            cardComputerId: self.activities.card?.attributes.computerId,
                            state: self.store.state(of: computerId),
                            targets: self.store.chats(on: computerId).map {
                                .init(id: $0.id, name: $0.title, archived: $0.archived)
                            }, sessionId: sid, confirmedName: confirmedName)
                    })
                guard self.store.activeId == computerId else {
                    return "Delivery not confirmed. Computer changed. Open app to review the original computer's outbox."
                }
                return delivered ? "Sent to the confirmed chat. Not completed. Open app for progress." : "Queued, not sent yet. Open app to review delivery."
            }
        }
        talker.show = { [weak self] listening, reply in self?.activities.talk(listening: listening, heard: reply) }
        IntentRouter.talkToNekko = { [weak self] computerId in
            guard let self else { return }
            // This path is invoked only by authenticated recording intents.
            guard UIApplication.shared.isProtectedDataAvailable,
                  self.activities.card?.attributes.computerId == computerId else {
                self.voiceDispatcher.cancel()
                self.activities.talk(listening: false, heard: "Not sent. Unlock iPhone and open app to try voice.")
                return
            }
            // Do not mutate the scope of a capture already in flight.
            if self.talker.busy {
                if self.voiceComputerId == computerId { self.talker.finishListening() }
                return
            }
            self.voiceComputerId = computerId
            await self.talker.talk()
            self.voiceComputerId = nil
        }
        // Compatibility with a card drawn before this update: ignore its chat id.
        IntentRouter.talk = { [weak self] _ in
            guard let id = self?.activities.card?.attributes.computerId else { return }
            await IntentRouter.talkToNekko?(id)
        }
        IntentRouter.finishTalk = { [weak self] in self?.talker.finishListening() }
        IntentRouter.cancelTalk = { [weak self] in self?.talker.cancel() }
    }

    /// The composer of `chatId` takes a waiting `?listen=1` once: only for a chat the
    /// phone's list has, and never behind the app lock.
    func takeListen(_ chatId: String) -> Bool {
        guard let id = listenIn, id == chatId, !(prefs.appLock && lock.locked) else { return false }
        guard store.summaries.contains(where: { $0.id == id }) else {
            if store.summariesLoaded { listenIn = nil }
            return false
        }
        listenIn = nil
        return true
    }

    /// The approval card of `chatId` takes a waiting "Always allow" once, for the
    /// call it was asked for only, and never behind the app lock. The card then
    /// does what its own button does: the save asks for Face ID or the passcode,
    /// and nothing is allowed unless the save went through.
    func takeAlwaysAllow(_ chatId: String, callId: String) -> Bool {
        guard let want = alwaysAllowIn, want.chatId == chatId, want.callId == callId, !(prefs.appLock && lock.locked) else { return false }
        alwaysAllowIn = nil
        return true
    }

    /// The card's push token. A card the relay started can wake the app in the
    /// background (locked, so `start` never ran): connect just to register the
    /// token, as `deliverInBackground` does, and let the connection close as that does.
    private func cardTokenArrived(_ token: String?) {
        Log.push.info("Live Activity push token \(token == nil ? "cleared" : "arrived", privacy: .public), connection \(String(describing: self.store.conn), privacy: .public)")
        store.cardToken = token
        guard token != nil, store.conn != .online else { return }
        Task {
            // Registering a token is not reading chats: the app lock doesn't hold it.
            start(force: true)
            if store.conn != .online { store.reconnect() }
            _ = await waitOnline(seconds: 20)
        }
    }

    /// The level goes to the relay and the computer (`ComputersStore.cardLevel`).
    private func watchCardLevel() {
        store.cardLevel = withObservationTracking { prefs.liveActivityLevel } onChange: { [weak self] in
            Task { @MainActor in self?.watchCardLevel() }
        }
    }

    private func watchCard() {
        withObservationTracking {
            activities.refresh()
        } onChange: { [weak self] in
            Task { @MainActor in self?.watchCard() }
        }
    }

    // MARK: Events → haptics, notifications, Live Activities

    private func onEvent(_ e: AgentEvent, computerId: String) {
        let chat = store.chats(on: computerId).first { $0.id == e.sessionId }
        let computer = store.computers.first { $0.id == computerId }
        if computerId == store.activeId { activities.onEvent(e) }
        switch e {
        case .approvalRequired, .question:
            if foreground, prefs.hapticNeedsYou { Haptics.needsYou() }
        case .done:
            if foreground, prefs.hapticDone { Haptics.done() }
        default:
            break
        }
        // Only currently listed chats and enabled kinds. Attention also reaches an unrelated foreground chat.
        guard let kind = PushKind.of(e), (!foreground || kind == .needsYou), prefs.wants(kind), let chat else { return }
        notifier.post(e, chatTitle: chat.title.isEmpty ? "Chat" : chat.title, computer: computer?.name ?? "Your computer",
                      hideContent: prefs.appLock, computerId: computerId)
    }

    /// From a notification action or a Live Activity button: wait for the
    /// connection (the app may have just been woken), then answer. Callers
    /// await it, and it holds background time until the answer is sent, so iOS
    /// does not suspend the app mid-answer. A failure is posted as a
    /// notification rather than dropped: the user believes they answered.
    func answerApproval(_ sessionId: String, _ callId: String, _ allow: Bool) async {
        // Allowing a tool from outside the app needs an unlocked phone (the
        // notification action asks for it; a Lock Screen button may not).
        Log.approval.info("\(allow ? "Allow" : "Deny", privacy: .public) from outside the app for chat \(sessionId, privacy: .private(mask: .hash))")
        if allow && !UIApplication.shared.isProtectedDataAvailable {
            Log.approval.notice("Allow not sent: the phone is locked")
            notifier.postUnsent(sessionId: sessionId, allow: allow, why: "Allowing a tool needs your iPhone unlocked.")
            return
        }
        let time = BackgroundTime("nekko.approval")
        defer { time.end() }
        start(force: true)
        store.focus(chat: sessionId)
        store.resume()
        guard await waitOnline(seconds: 10), let r = try? store.remote() else {
            Log.approval.error("Answer not sent: no connection within 10 s (\(String(describing: self.store.conn), privacy: .public))")
            notifier.postUnsent(sessionId: sessionId, allow: allow, why: "Couldn’t reach \(store.active?.name ?? "your computer").")
            return
        }
        do {
            _ = try await r.call(Channels.toolApprove, [.string(sessionId), .string(callId), .bool(allow)])
        } catch {
            Log.approval.error("Answer not sent: \(error.localizedDescription)")
            notifier.postUnsent(sessionId: sessionId, allow: allow, why: "\(store.active?.name ?? "Your computer") didn’t take it: \(error.localizedDescription)")
            return
        }
        Log.approval.info("Answer delivered")
        notifier.clear(sessionId: sessionId)
        await store.refreshAttention()
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
    /// edition link), `nekko-agent://chat/<id>` (`?listen=1` starts listening, `?alwaysAllow=<call id>`
    /// runs that call's "Always allow this tool"), `nekko-agent://new` or `nekko-agent://chats`.
    func handle(url: URL) {
        if url.scheme == "nekko-agent", url.host == "chat" {
            openChat = url.pathComponents.dropFirst().first
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let listen = items.contains { $0.name == "listen" && $0.value == "1" }
            listenIn = listen ? openChat : nil
            let always = items.first { $0.name == "alwaysAllow" }?.value.flatMap { $0.isEmpty ? nil : $0 }
            alwaysAllowIn = openChat.flatMap { chat in always.map { AlwaysAllowRequest(chatId: chat, callId: $0) } }
            return
        }
        if url.scheme == "nekko-agent", url.host == "new" {
            newChatRequested = true
            return
        }
        // The card's count line ("3 Working · 5 Done"): opening the app is the point.
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
        let id: String
        do { id = try await store.pair(link) } catch { return error.localizedDescription }
        if prefs.defaultComputer == nil { prefs.defaultComputer = id }
        justPaired = id
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
        await permissionChecklistChanged()
    }

    /// Reconcile a deliberate checklist change, including first-pair APNs enrollment.
    func permissionChecklistChanged() async {
        guard !NativeFixtureRoute.isolated else { return }
        await refreshNotificationPermission()
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if [.authorized, .provisional, .ephemeral].contains(status), !store.computers.isEmpty {
            registerForPush()
        }
    }

    /// Settings → Notifications: one kind on or off, and the relay asked for only the kinds on.
    func setNotify(_ kind: PushKind, _ on: Bool) {
        switch kind {
        case .needsYou: prefs.notifyNeedsYou = on
        case .finished: prefs.notifyFinished = on
        case .failed: prefs.notifyFailed = on
        case .test: return
        }
        Task { await refreshNotificationPermission() }
        notifier.reconcileBadge()
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

    private func watchBadge() {
        withObservationTracking {
            _ = store.attentionCount
            _ = prefs.notifyNeedsYou
            notifier.reconcileBadge()
        } onChange: { [weak self] in
            Task { @MainActor in self?.watchBadge() }
        }
    }

    private func refreshNotificationPermission() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        store.pushKinds = allowed ? prefs.pushKinds : []
        notifier.reconcileBadge()
    }

    func receivedRemoteNotification(_ info: NativeNotificationInfo) {
        // Invalidate synchronously before any queued local badge write resumes.
        store.withdrawAttentionAuthority()
        if let tag = info.dismiss { Task { await Notifier.dismissNeedsYou(tag: tag) } }
        if started { Task { await store.reconcileAttention() } }
    }

    func didRegister(deviceToken: Data) {
        Log.push.info("Registered for push")
        store.setPushToken(deviceToken.map { String(format: "%02x", $0) }.joined())
        Task { await refreshNotificationPermission() }
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
        if prefs.chatsFilter == id { prefs.chatsFilter = nil }
        prefs.lastModel[id] = nil
        prefs.lastEffort[id] = nil
        prefs.lastTools[id] = nil
        prefs.lastFolder[id] = nil
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
        phone.forgetAll()
        connectors.forgetAll()
        connectorKeychain.wipe()
        chatLists.removeAll()
        transcriptFiles.removeAll()
        offlineFiles.removeAll()
        OutboxRefresh.cancel()
        keychain.wipe()
        activities.endAll()
        prefs.defaultComputer = nil
        prefs.chatsFilter = nil
        prefs.lastModel = [:]
        prefs.lastEffort = [:]
        prefs.lastTools = [:]
        prefs.lastFolder = [:]
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

/// Injectable preparation for the app's real outbox path, without app lifecycle IO.
@MainActor
enum CardVoiceDelivery {
    static func send(outbox: Outbox, sessionId: String, text: String, permit: NekkoVoiceCommit,
                     waitOnline: () async -> Bool, allowed: @escaping () -> Bool) async throws -> Bool {
        guard permit.isCurrent, allowed() else { throw CancellationError() }
        let online = await waitOnline()
        return try await outbox.sendWaiting(chatId: sessionId, text: text, wait: online ? 10 : 0,
                                            beforeEnqueue: { permit.commit(if: allowed) })
    }
}
