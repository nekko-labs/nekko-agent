import Foundation
import NekkoProtocol

/// Live pending inputs, independent of unread messages and the Live Activity card.
/// A complete read is required on every connection. Events cannot prove an empty room.
public struct AttentionState: Equatable, Sendable {
    private struct Inputs: Equatable, Sendable {
        var approvals: Set<String> = []
        var questions: Set<String> = []
        var secrets: Set<String> = []
        var pending: Bool { !approvals.isEmpty || !questions.isEmpty || !secrets.isEmpty }
    }
    private enum Change: Equatable, Sendable {
        case event(AgentEvent)
    }
    public private(set) var known = false
    private var inputs: [String: Inputs] = [:]
    private var ticket: UUID?
    private var changes: [Change] = []
    private var awaitingDismiss: Set<String> = []

    public init() {}
    public var pending: Set<String> { Set(inputs.filter { $0.value.pending }.keys) }
    public var count: Int? { known ? pending.count : nil }

    public mutating func invalidate() {
        known = false
        ticket = nil
        changes = []
    }

    /// Only the latest read on this connection may replace the state.
    public mutating func beginSnapshot() -> UUID {
        let id = UUID()
        ticket = id
        changes = []
        return id
    }

    @discardableResult
    public mutating func replace(_ raw: JSONValue?, ticket id: UUID) -> Set<String> {
        guard ticket == id else { return [] }
        guard let object = raw?.object, object.count <= 4096 else { invalidate(); return [] }
        let parsed = PendingInput.map(raw)
        // A malformed response is not proof that a room has no pending inputs.
        guard parsed.count == object.count, object.allSatisfy({ sid, value in
            let p = parsed[sid]
            return (value["approval"] == nil || value["approval"] == .null || p?.approval != nil)
                && (value["question"] == nil || value["question"] == .null || p?.question != nil)
                && (value["secret"] == nil || value["secret"] == .null || p?.secret != nil)
        }) else { invalidate(); return [] }
        var next = AttentionState()
        for (sid, p) in parsed {
            var input = Inputs()
            if let a = p.approval { input.approvals.insert(a.call.id) }
            if let q = p.question { input.questions.insert(q.callId) }
            if let s = p.secret { input.secrets.insert(s.callId) }
            if input.pending { next.inputs[sid] = input }
        }
        // Replay new inputs while the read was in flight. A resolution cancels
        // the ticket instead: chat:pending exposes only the newest input of each
        // kind, so removing even a matching id cannot prove that chat is empty.
        for change in changes { next.apply(change) }
        let nextTags = Set(next.pending.map(E2E.activityTag))
        let dismissed = Set(pending.map(E2E.activityTag)).union(awaitingDismiss).subtracting(nextTags)
        awaitingDismiss.subtract(dismissed)
        inputs = next.inputs
        known = true
        ticket = nil
        changes = []
        return dismissed
    }

    /// True means a full re-read is needed, even for an unobserved resolution.
    @discardableResult
    public mutating func receive(_ event: AgentEvent) -> Bool {
        switch event {
        case .questionResolved, .secretResolved, .toolResult, .done, .error:
            invalidate()
            return true
        case .approvalRequired, .question, .secretRequest:
            record(.event(event))
        default: break
        }
        return false
    }

    public mutating func dismiss(tag: String) {
        awaitingDismiss.insert(tag)
        invalidate()
    }

    private mutating func record(_ change: Change) {
        if ticket != nil {
            if changes.count >= 4096 { invalidate() } else { changes.append(change) }
        }
        apply(change)
    }

    private mutating func apply(_ change: Change) {
        switch change {
        case .event(let e):
            let sid = e.sessionId
            var input = inputs[sid] ?? Inputs()
            switch e {
            case .approvalRequired(_, let a): input.approvals.insert(a.call.id)
            case .question(_, let q): input.questions.insert(q.callId)
            case .secretRequest(_, let s): input.secrets.insert(s.callId)
            default: return // Streaming output does not resolve a waiting input.
            }
            inputs[sid] = input.pending ? input : nil
        }
    }

    /// Replace only the needs-you projection, retaining unrelated working rows.
    public func projecting(_ activity: [String: Activity]) -> [String: Activity] {
        var next = activity.filter { $0.value != .needsYou }
        for sid in pending { next[sid] = .needsYou }
        return next
    }
}

extension ComputersStore {
    /// Nil means at least one paired computer is not fully read on its current link.
    /// Equal chat ids on different computers are distinct entries.
    public var attentionCount: Int? {
        guard ready else { return nil }
        var total = 0
        for computer in computers {
            guard let count = attention[computer.id]?.count else { return nil }
            total += count
        }
        return total
    }

    func beginAttention(_ id: String) -> UUID {
        var state = attention[id] ?? AttentionState()
        let ticket = state.beginSnapshot()
        attention[id] = state
        return ticket
    }

    func replaceAttention(_ raw: JSONValue?, on id: String, ticket: UUID) {
        let dismissed = attention[id]?.replace(raw, ticket: ticket) ?? []
        projectAttention(id)
        for tag in dismissed.sorted() { onDismiss?(tag) }
    }

    func receiveAttention(_ event: AgentEvent, on id: String) {
        let before = attention[id] ?? AttentionState()
        var next = before
        let reread = next.receive(event)
        if next != before { attention[id] = next }
        projectAttention(id)
        if reread { scheduleAttentionRefresh(id) }
    }

    func dismissAttention(tag: String, on id: String) {
        if attention[id] == nil { attention[id] = AttentionState() }
        attention[id]?.dismiss(tag: tag)
        projectAttention(id)
        scheduleAttentionRefresh(id)
    }

    func invalidateAttention(_ id: String) {
        if attention[id] == nil { attention[id] = AttentionState() }
        attention[id]?.invalidate()
    }

    /// A remote push may be newer than the phone's live snapshots. Do not race its
    /// absolute badge with a cached local total; re-read every computer first.
    public func withdrawAttentionAuthority() {
        for computer in computers { invalidateAttention(computer.id) }
    }

    public func reconcileAttention() async {
        withdrawAttentionAuthority()
        if conn == .online { await refreshAttention() }
        await refreshFleet()
    }

    private func attentionClient(_ id: String) -> RemoteConnection? {
        if id == activeId { return conn == .online ? client : nil }
        return peers[id]?.conn == .online ? links[id]?.client : nil
    }

    private func scheduleAttentionRefresh(_ id: String) {
        // Capture both the link and ticket before yielding. Reconnection,
        // handoff, another resolution or a newer read can obsolete this result.
        guard let c = attentionClient(id) else { return }
        let ticket = beginAttention(id)
        Task { await readAttention(id, client: c, ticket: ticket) }
    }

    private func readAttention(_ id: String, client c: RemoteConnection, ticket: UUID) async {
        let raw = try? await c.call(Channels.chatPending, [], timeout: 5)
        guard attentionClient(id) === c else { return }
        replaceAttention(raw, on: id, ticket: ticket)
    }

    public func refreshAttention() async {
        guard let id = activeId, let c = attentionClient(id) else { return }
        let ticket = beginAttention(id)
        await readAttention(id, client: c, ticket: ticket)
    }

    private func projectAttention(_ id: String) {
        guard let state = attention[id] else { return }
        if id == activeId {
            let next = state.projecting(activity)
            if next != activity { activity = next }
        } else if let peer = peers[id] {
            let next = state.projecting(peer.activity)
            if next != peer.activity { peers[id]?.activity = next }
        }
    }
}
