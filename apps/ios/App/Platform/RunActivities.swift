// Activity is meant to be updated and ended from any task, but ActivityKit does not
// mark it Sendable yet.
@preconcurrency import ActivityKit
import Foundation
import os
import NekkoKit
import NekkoProtocol

/// The card as `RunActivities` drives it: ActivityKit in the app, a fake in the tests.
@MainActor
protocol CardActivity: AnyObject {
    var attributes: NekkoCardAttributes { get }
    /// What the card shows now.
    var state: LiveCardState { get }
    /// False once the user swiped it away or iOS ended it (8 hours).
    var isLive: Bool { get }
    /// ActivityKit's id for it.
    var id: String { get }
    /// Its ActivityKit push token, hex, each time iOS issues one.
    var onPushToken: ((String) -> Void)? { get set }
    func update(_ state: LiveCardState)
    func end()
}

/// The one Live Activity card for all of the computer's chats (`buildCard`),
/// rebuilt from the chat list, who is running, and what each run is doing
/// (the computer's events). Updates are throttled (ActivityKit budgets them)
/// except for what the user must see at once: a chat changing state, joining
/// or leaving, and a tap on the card.
///
/// While iOS has the app suspended the computer builds the same card
/// (crates/nekko-remote card.rs) and the relay pushes it to the card's push
/// token (`onCardToken`), or starts one with the push-to-start token for a run
/// this phone asked for (`adopt`). Without the relay's APNs key the card keeps
/// its last state until the app runs again or iOS ends it (8 hours).
@MainActor
final class RunActivities {
    /// The active computer's chats and who is running.
    struct Source {
        var summaries: [SessionSummary]
        var activity: [String: NekkoProtocol.Activity]
        var computerId: String
        var computerName: String
    }

    /// What the events say about a chat's latest run (the chat list doesn't).
    private struct Run {
        var startedAt: Date
        var lastEventAt: Date
        var step = ""
        var callId: String?
        var severity: String?
        var finished: LiveChatState?
        var finishedAt: Date?
    }

    private(set) var card: CardActivity?
    /// What a card the user swiped away last showed (kept current while there is
    /// no card): a new one starts only for a chat that newly needs you or is new.
    private var swiped: LiveCardState?
    private var runs: [String: Run] = [:]
    /// Closed with the card's button; off the card until the chat runs again.
    private var dismissed: Set<String> = []
    /// The chat a chip tap brought up, until another chat newly needs you.
    var pinnedFocus: String?
    /// The chat the card's mic last sent to, and its reply line then: "Sent: ..." stays until that changes.
    private var sentTo: (id: String, reply: String)?
    /// When the mic said something with no reply to wait for ("Not sent: ..."): it leaves after `noteSeconds`.
    private var noteAt: Date?
    static let noteSeconds: TimeInterval = 60
    private var lastUpdate: Date?
    private var expiry: Task<Void, Never>?
    /// The update a throttled refresh put off, sent once the 2 s are up.
    private var trailing: Task<Void, Never>?
    /// How long a run the events saw counts as working with no word from
    /// `activity` (a reconnect empties it until the next event).
    static let quietRun: TimeInterval = 30 * 60
    private let request: @MainActor (NekkoCardAttributes, LiveCardState) -> CardActivity?

    var level: () -> LiveLevel = { .none }
    /// The card's push token for the relay, nil once the card is gone.
    var onCardToken: (String?) -> Void = { _ in }
    /// Nil until the computer's chat list has loaded: the card keeps its own chats meanwhile.
    var source: () -> Source? = { nil }

    /// `adoptLeftover`: carry on with a card an earlier launch left up.
    init(request: @escaping @MainActor (NekkoCardAttributes, LiveCardState) -> CardActivity? = SystemCard.request, adoptLeftover: Bool = true) {
        self.request = request
        if adoptLeftover, let leftover = SystemCard.leftover() {
            card = leftover
            attach(leftover)
        }
    }

    func onEvent(_ e: AgentEvent) {
        let sid = e.sessionId
        let now = Date()
        func running(_ step: String, callId: String? = nil, severity: String? = nil) {
            var run = runs[sid].flatMap { $0.finished == nil ? $0 : nil } ?? Run(startedAt: now, lastEventAt: now)
            run.lastEventAt = now
            run.step = step
            run.callId = callId
            run.severity = severity
            runs[sid] = run
            dismissed.remove(sid)
        }
        func finish(_ state: LiveChatState, _ step: String) {
            var run = runs[sid] ?? Run(startedAt: now, lastEventAt: now)
            run.lastEventAt = now
            run.finished = state
            run.finishedAt = now
            run.step = step
            run.callId = nil
            runs[sid] = run
        }
        switch e {
        case .text, .reasoning: running(String(localized: "Writing…"))
        case .toolCall(_, let call): running(Transcript.toolLabel(call))
        case .approvalRequired(_, let a): running(Transcript.toolLabel(a.call), callId: a.call.id, severity: a.severity.rawValue)
        case .question(_, let q): running(q.questions.first?.question ?? String(localized: "A question for you"))
        case .toolResult, .questionResolved: running(String(localized: "Working…"))
        case .done: finish(.done, String(localized: "Finished"))
        case .error(_, let message):
            let stopped = ["stopped", "aborted"].contains(message.lowercased())
            finish(stopped ? .done : .failed, stopped ? String(localized: "Stopped") : String(localized: "Stopped with an error"))
        default: return
        }
        // Listeners hear an event before the store applies it to `activity`.
        Task { @MainActor [weak self] in self?.refresh() }
    }

    /// A chip (or "+N", which names the chat that starts the next page).
    func focus(_ sessionId: String) {
        pinnedFocus = sessionId
        refresh(urgent: true)
    }

    /// The close button under a finished chat.
    func dismiss(_ sessionId: String) {
        dismissed.insert(sessionId)
        if pinnedFocus == sessionId { pinnedFocus = nil }
        refresh(urgent: true)
    }

    /// The card's mic (`TalkRunner`): listening, then what was sent ("Sent: ...") until
    /// `sentTo`'s reply line changes or another chat takes the card, or why nothing was
    /// (no `sentTo`) for a minute, cleared by the first refresh after that. Shown at once.
    func talk(listening: Bool, heard: String, sentTo: String? = nil, now: Date = Date()) {
        guard let card else { return }
        var state = card.state
        state.listening = listening
        state.heard = heard
        self.sentTo = sentTo.map { id in (id, state.chats.first { $0.id == id }?.reply ?? "") }
        noteAt = sentTo == nil && !heard.isEmpty && !listening ? now : nil
        card.update(state)
        lastUpdate = Date()
    }

    /// Starts, updates or ends the card to match the chats now.
    func refresh(now: Date = Date(), urgent: Bool = false) {
        runs = runs.filter { _, run in run.finishedAt.map { now.timeIntervalSince($0) <= LiveCardRules.finishedTail } ?? true }
        if let gone = card, !gone.isLive {
            card = nil
            onCardToken(nil)
            swiped = gone.state
            lastUpdate = nil
            trailing?.cancel()
            trailing = nil
        }
        let level = level()
        let chats: [LiveChat], computerId: String, computerName: String
        if let src = source() {
            chats = liveChats(src, now: now)
            (computerId, computerName) = (src.computerId, src.computerName)
        } else if let card {
            // A tap on the card can launch the app before it has the list.
            chats = card.state.chats.filter { !dismissed.contains($0.id) }
            (computerId, computerName) = (card.attributes.computerId, card.attributes.computerName)
        } else {
            return
        }
        let attributes = NekkoCardAttributes(computerId: computerId, computerName: computerName, level: level)
        // A card's level (and computer) is fixed for its life: a change starts a new one.
        if let card, card.attributes != attributes { end() }
        let previous = card?.state ?? swiped
        guard var state = buildCard(chats: chats, previous: previous, pinnedFocus: pinnedFocus, level: level, now: now) else {
            end()
            return
        }
        if let sent = sentTo, state.focusId != sent.id || state.chats.first(where: { $0.id == sent.id })?.reply != sent.reply {
            state.heard = ""
            sentTo = nil
        }
        if let at = noteAt, now.timeIntervalSince(at) >= Self.noteSeconds {
            state.heard = ""
            noteAt = nil
        }
        if state.focusId != pinnedFocus { pinnedFocus = nil }
        scheduleExpiry(state)
        guard let card else {
            if let gone = swiped {
                swiped = state
                let before = Dictionary(gone.chats.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
                let news = state.chats.contains { before[$0.id] == nil || ($0.state == .needsYou && before[$0.id] != .needsYou) }
                guard news else { return }
            }
            swiped = nil
            card = request(attributes, state)
            if let card { attach(card) }
            lastUpdate = now
            return
        }
        guard state != previous else { return }
        func shape(_ s: LiveCardState?) -> [String] { s?.chats.map { "\($0.id) \($0.state) \($0.callId ?? "")" } ?? [] }
        let seenAtOnce = urgent || state.focusId != previous?.focusId || shape(state) != shape(previous)
        if !seenAtOnce, let lastUpdate, now.timeIntervalSince(lastUpdate) < 2 {
            if trailing == nil {
                let at = lastUpdate.addingTimeInterval(2)
                trailing = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(max(0, at.timeIntervalSinceNow) * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    self?.trailing = nil
                    self?.refresh()
                }
            }
            return
        }
        trailing?.cancel()
        trailing = nil
        card.update(state)
        lastUpdate = now
    }

    #if DEBUG
    /// `-uiTestLiveCard`: a card with sample chats and no computer, to see on the simulator.
    func showSample(_ state: LiveCardState) {
        end()
        card = request(NekkoCardAttributes(computerId: "sample", computerName: "Mac", level: level()), state)
    }
    #endif

    /// A card that appeared without this app asking: the relay started it
    /// (push-to-start). It is the card unless one is already up.
    func adopt(_ new: CardActivity) {
        if let card {
            if card.id != new.id { new.end() }
            return
        }
        swiped = nil
        card = new
        attach(new)
        lastUpdate = Date()
    }

    private func attach(_ c: CardActivity) {
        c.onPushToken = { [weak self, weak c] token in
            guard let self, let c, self.card === c else { return }
            self.onCardToken(token)
        }
    }

    /// The phone disconnected from the computer or it was forgotten: nothing here is live any more.
    func endAll() {
        end()
        runs = [:]
        dismissed = []
        pinnedFocus = nil
    }

    private func end() {
        if let card {
            card.end()
            onCardToken(nil)
        }
        card = nil
        swiped = nil
        lastUpdate = nil
        expiry?.cancel()
        trailing?.cancel()
        trailing = nil
    }

    private func liveChats(_ src: Source, now: Date) -> [LiveChat] {
        src.summaries.compactMap { s in
            guard !s.archived, !dismissed.contains(s.id) else { return nil }
            let run = runs[s.id]
            let live = run?.finished == nil ? run : nil
            let state: LiveChatState, step: String
            switch src.activity[s.id] {
            case .needsYou?: (state, step) = (.needsYou, live?.step ?? "")
            case .running?: (state, step) = (.working, live?.step ?? "")
            case nil:
                if let live, now.timeIntervalSince(live.lastEventAt) < Self.quietRun { (state, step) = (.working, live.step) }
                else if s.activeWatchCount > 0 { (state, step) = (.watching, String(localized: "Watching PR…")) }
                else if let run, let finished = run.finished { (state, step) = (finished, run.step) }
                else { return nil }
            }
            let finished = state == .done || state == .failed
            return LiveChat(id: s.id, short: shortTitle(s.title.isEmpty ? "Chat" : s.title), state: state, step: step,
                            reply: replyLine(s.lastReplyText), closeWord: closeWord(for: s.id, failed: state == .failed),
                            finishedAt: finished ? run?.finishedAt : nil,
                            callId: state == .needsYou ? live?.callId : nil, severity: state == .needsYou ? live?.severity : nil,
                            startedAt: live?.startedAt)
        }
    }

    /// Ends the card on time when its last finished chat's two hours are up (while the app runs).
    private func scheduleExpiry(_ state: LiveCardState) {
        expiry?.cancel()
        guard let first = (runs.values.compactMap(\.finishedAt) + state.chats.compactMap(\.finishedAt)).min() else { return }
        let at = first.addingTimeInterval(LiveCardRules.finishedTail + 1)
        expiry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, at.timeIntervalSinceNow) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }
}

/// The card in ActivityKit. Its two observers (push tokens, pushed content)
/// end with it: in `end()`, and in `deinit` for a card replaced without one.
@MainActor
final class SystemCard: CardActivity {
    private let activity: ActivityKit.Activity<NekkoCardAttributes>
    private(set) var state: LiveCardState
    var attributes: NekkoCardAttributes { activity.attributes }
    var isLive: Bool { activity.activityState == .active || activity.activityState == .stale }
    var id: String { activity.id }
    var onPushToken: ((String) -> Void)? {
        didSet {
            let a = activity
            observers.set("tokens", Task { [weak self] in
                for await token in a.pushTokenUpdates { self?.onPushToken?(hex(token)) }
            })
        }
    }
    /// The token and content observers, cancellable from `deinit` too.
    private let observers = TaskBag()
    /// The last call to ActivityKit; each one waits for it so they arrive in order.
    private var last: Task<Void, Never>?

    private init(_ activity: ActivityKit.Activity<NekkoCardAttributes>, state: LiveCardState) {
        self.activity = activity
        self.state = state
        let a = activity
        observers.set("pushes", Task { [weak self] in
            for await content in a.contentUpdates {
                guard let self, let kept = Self.keepingVoice(pushed: content.state, local: self.state) else { continue }
                self.update(kept)
            }
        })
    }

    deinit { observers.cancelAll() }

    /// A pushed card says listening false and heard "" (the computer can't know): while the
    /// mic listens, the push's chats with this phone's listening and heard. Nil when nothing to put back.
    static func keepingVoice(pushed: LiveCardState, local: LiveCardState) -> LiveCardState? {
        guard local.listening, pushed.listening != local.listening || pushed.heard != local.heard else { return nil }
        var kept = pushed
        kept.listening = local.listening
        kept.heard = local.heard
        return kept
    }

    func update(_ state: LiveCardState) {
        self.state = state
        let content = ActivityContent(state: state, staleDate: Self.staleDate)
        send { await $0.update(content) }
    }

    func end() {
        observers.cancelAll()
        send { await $0.end(nil, dismissalPolicy: .immediate) }
    }

    private func send(_ call: @escaping (ActivityKit.Activity<NekkoCardAttributes>) async -> Void) {
        let previous = last, a = activity
        last = Task {
            await previous?.value
            await call(a)
        }
    }

    /// A card nothing has updated for a while (the app suspended, no push) reads as stale.
    private static var staleDate: Date { Date().addingTimeInterval(15 * 60) }

    static func request(_ attributes: NekkoCardAttributes, _ state: LiveCardState) -> CardActivity? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
        let content = ActivityContent(state: state, staleDate: staleDate)
        // With a push token, so the relay can update it; without one if iOS refuses that.
        guard let a = (try? ActivityKit.Activity.request(attributes: attributes, content: content, pushType: .token))
            ?? (try? ActivityKit.Activity.request(attributes: attributes, content: content))
        else { return nil }
        return SystemCard(a, state: state)
    }

    /// Cards the relay starts (`adopt`), and the push-to-start token for the relay (iOS 17.2 and later).
    static func watch(adopt: @escaping @MainActor (CardActivity) -> Void, startToken: @escaping @MainActor (String) -> Void) {
        Task { @MainActor in
            for await a in ActivityKit.Activity<NekkoCardAttributes>.activityUpdates where a.activityState == .active {
                adopt(SystemCard(a, state: a.content.state))
            }
        }
        if #available(iOS 17.2, *) {
            Task { @MainActor in
                for await token in ActivityKit.Activity<NekkoCardAttributes>.pushToStartTokenUpdates { startToken(hex(token)) }
            }
        }
    }

    /// The card an earlier launch left up, if any. Extra cards, and the
    /// one-per-chat activities of earlier versions, end.
    static func leftover() -> CardActivity? {
        for a in ActivityKit.Activity<AgentRunAttributes>.activities { Task { await a.end(nil, dismissalPolicy: .immediate) } }
        // A stale card (past its staleDate while the app was suspended) is still up.
        let cards = ActivityKit.Activity<NekkoCardAttributes>.activities.filter { $0.activityState != .ended && $0.activityState != .dismissed }
        for a in cards.dropFirst() { Task { await a.end(nil, dismissalPolicy: .immediate) } }
        return cards.first.map { SystemCard($0, state: $0.content.state) }
    }
}

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

/// The one-per-chat activity of earlier versions, only so launch can end any
/// still up. shortcut: matched by its type name; delete once no install has one (8 hours after updating).
struct AgentRunAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {}
}

/// The card's mic (Part 5), from the tap to the message: listening on the card, one
/// segment (`Dictation.captureOnce`), sent to that chat, then "Sent: ..." on the card.
/// The same intent again while listening ("Send to") ends listening now; Cancel sends nothing.
@MainActor
final class TalkRunner {
    var capture: () async throws -> String = { "" }
    /// Ends listening now, keeping what was said.
    var finish: () -> Void = {}
    /// Ends listening, keeping nothing.
    var discard: () -> Void = {}
    var send: (_ sessionId: String, _ text: String) async throws -> Void = { _, _ in }
    /// `RunActivities.talk`.
    var show: (_ listening: Bool, _ heard: String, _ sentTo: String?) -> Void = { _, _, _ in }
    private var listening = false
    private var cancelled = false

    func talk(_ sessionId: String) async {
        if listening { return finish() }
        listening = true
        cancelled = false
        show(true, "", nil)
        var heard = ""
        var sent = false
        do {
            let text = try await capture().trimmingCharacters(in: .whitespacesAndNewlines)
            listening = false
            if !text.isEmpty, !cancelled {
                try await send(sessionId, text)
                heard = String(localized: "Sent: \(text)")
                sent = true
            }
        } catch {
            listening = false
            heard = String(localized: "Not sent: \(error.localizedDescription)")
        }
        show(false, heard, sent ? sessionId : nil)
    }

    func cancel() {
        guard listening else { return }
        cancelled = true
        discard()
    }
}

/// Tasks cancelled together, from any context (a `deinit` included): a lock
/// around the handles, so it is checked `Sendable`.
final class TaskBag: Sendable {
    private let tasks = OSAllocatedUnfairLock<[String: Task<Void, Never>]>(initialState: [:])

    /// Keeps `task` under `key`, cancelling the one it replaces.
    func set(_ key: String, _ task: Task<Void, Never>) {
        tasks.withLock { all in
            all[key]?.cancel()
            all[key] = task
        }
    }

    func cancelAll() {
        tasks.withLock { all in
            for task in all.values { task.cancel() }
            all = [:]
        }
    }
}
