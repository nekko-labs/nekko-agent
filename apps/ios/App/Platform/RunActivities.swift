import ActivityKit
import Foundation
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
    func update(_ state: LiveCardState)
    func end()
}

/// The one Live Activity card for all of the computer's chats (`buildCard`),
/// rebuilt from the chat list, who is running, and what each run is doing
/// (the computer's events). Updates are throttled (ActivityKit budgets them)
/// except for what the user must see at once: a chat changing state, joining
/// or leaving, and a tap on the card.
///
/// Until the relay pushes the card (Part 4), it changes only while the app
/// runs. iOS suspends the app shortly after it leaves the screen; the card then
/// keeps its last state, finished chats included, until the app runs again or
/// iOS ends it (8 hours).
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
    private var lastUpdate: Date?
    private var expiry: Task<Void, Never>?
    /// The update a throttled refresh put off, sent once the 2 s are up.
    private var trailing: Task<Void, Never>?
    /// How long a run the events saw counts as working with no word from
    /// `activity` (a reconnect empties it until the next event).
    static let quietRun: TimeInterval = 30 * 60
    private let request: (NekkoCardAttributes, LiveCardState) -> CardActivity?

    var level: () -> LiveLevel = { .none }
    /// Nil until the computer's chat list has loaded: the card keeps its own chats meanwhile.
    var source: () -> Source? = { nil }

    /// `adoptLeftover`: carry on with a card an earlier launch left up.
    init(request: @escaping (NekkoCardAttributes, LiveCardState) -> CardActivity? = SystemCard.request, adoptLeftover: Bool = true) {
        self.request = request
        if adoptLeftover { card = SystemCard.leftover() }
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

    /// Starts, updates or ends the card to match the chats now.
    func refresh(now: Date = Date(), urgent: Bool = false) {
        runs = runs.filter { _, run in run.finishedAt.map { now.timeIntervalSince($0) <= LiveCardRules.finishedTail } ?? true }
        if let gone = card, !gone.isLive {
            card = nil
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
        guard let state = buildCard(chats: chats, previous: previous, pinnedFocus: pinnedFocus, level: level, now: now) else {
            end()
            return
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

    /// The phone disconnected from the computer or it was forgotten: nothing here is live any more.
    func endAll() {
        end()
        runs = [:]
        dismissed = []
        pinnedFocus = nil
    }

    private func end() {
        card?.end()
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

/// The card in ActivityKit.
final class SystemCard: CardActivity {
    private let activity: ActivityKit.Activity<NekkoCardAttributes>
    private(set) var state: LiveCardState
    var attributes: NekkoCardAttributes { activity.attributes }
    var isLive: Bool { activity.activityState == .active || activity.activityState == .stale }
    /// The last call to ActivityKit; each one waits for it so they arrive in order.
    private var last: Task<Void, Never>?

    private init(_ activity: ActivityKit.Activity<NekkoCardAttributes>, state: LiveCardState) {
        self.activity = activity
        self.state = state
    }

    func update(_ state: LiveCardState) {
        self.state = state
        let content = ActivityContent(state: state, staleDate: Self.staleDate)
        send { await $0.update(content) }
    }

    func end() {
        send { await $0.end(nil, dismissalPolicy: .immediate) }
    }

    private func send(_ call: @escaping (ActivityKit.Activity<NekkoCardAttributes>) async -> Void) {
        let previous = last, a = activity
        last = Task {
            await previous?.value
            await call(a)
        }
    }

    /// Nothing updates the card while the app is suspended (no pushes yet), so it reads as stale after a while.
    private static var staleDate: Date { Date().addingTimeInterval(15 * 60) }

    static func request(_ attributes: NekkoCardAttributes, _ state: LiveCardState) -> CardActivity? {
        guard ActivityAuthorizationInfo().areActivitiesEnabled,
              let a = try? ActivityKit.Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: staleDate))
        else { return nil }
        return SystemCard(a, state: state)
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

/// The one-per-chat activity of earlier versions, only so launch can end any
/// still up. shortcut: matched by its type name; delete once no install has one (8 hours after updating).
struct AgentRunAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {}
}
