import ActivityKit
import Foundation
import NekkoKit
import NekkoProtocol

/// Starts, updates and ends one Live Activity per running chat from the
/// computer's events. Updates are throttled (ActivityKit budgets them) except
/// for state changes the user must see at once: an approval, a question, the end.
///
/// Limitation: iOS suspends the app shortly after it leaves the screen, and the
/// relay connection with it, so updates stop until the app runs again. Keeping
/// them current while suspended needs ActivityKit push updates sent by the relay
/// (APNs `liveactivity` pushes), which is not built yet (see TASKS.md).
@MainActor
final class RunActivities {
    private var activities: [String: ActivityKit.Activity<AgentRunAttributes>] = [:]
    private var lastUpdate: [String: Date] = [:]
    private var steps: [String: Int] = [:]

    var enabled: () -> Bool = { true }
    var hideDetails: () -> Bool = { false }

    func onEvent(_ e: AgentEvent, chatTitle: String?, computerId: String, computerName: String) {
        guard enabled(), ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let sid = e.sessionId
        switch e {
        case .text, .reasoning:
            update(sid, title: chatTitle, computerId: computerId, computerName: computerName, phase: .running, step: "Writing…", urgent: false)
        case .toolCall(_, let call):
            steps[sid, default: 0] += 1
            let step = hideDetails() ? "Working…" : Transcript.toolLabel(call)
            update(sid, title: chatTitle, computerId: computerId, computerName: computerName, phase: .running, step: step, urgent: false)
        case .approvalRequired(_, let a):
            let step = hideDetails() ? "A tool needs your approval" : Transcript.toolLabel(a.call)
            update(sid, title: chatTitle, computerId: computerId, computerName: computerName, phase: .approval, step: step,
                   callId: a.call.id, severity: a.severity.rawValue, urgent: true)
        case .question(_, let q):
            let step = hideDetails() ? "Your computer has a question" : (q.questions.first?.question ?? "A question for you")
            update(sid, title: chatTitle, computerId: computerId, computerName: computerName, phase: .question, step: step, urgent: true)
        case .toolResult, .questionResolved:
            update(sid, title: chatTitle, computerId: computerId, computerName: computerName, phase: .running, step: "Working…", urgent: true)
        case .done:
            end(sid, phase: .done, step: "Finished")
        case .error(_, let message):
            let stopped = ["stopped", "aborted"].contains(message.lowercased())
            end(sid, phase: stopped ? .done : .failed, step: stopped ? "Stopped" : "Stopped with an error")
        default:
            break
        }
    }

    /// The phone disconnected from the computer or it was forgotten: nothing here is live any more.
    func endAll() {
        for sid in Array(activities.keys) { end(sid, phase: .done, step: "Open the app for the latest") }
    }

    private func update(_ sid: String, title: String?, computerId: String, computerName: String, phase: AgentRunAttributes.Phase,
                        step: String, callId: String? = nil, severity: String? = nil, urgent: Bool) {
        let now = Date()
        if !urgent, let last = lastUpdate[sid], now.timeIntervalSince(last) < 2 { return }
        lastUpdate[sid] = now
        if let a = activities[sid] {
            var state = a.content.state
            state.phase = phase
            state.step = step
            state.callId = callId
            state.severity = severity
            state.steps = steps[sid] ?? 0
            Task { await a.update(ActivityContent(state: state, staleDate: now.addingTimeInterval(15 * 60), relevanceScore: urgent ? 100 : 50)) }
            return
        }
        // Only chats the phone lists get one (not sub-agents, tasks or training runs).
        guard let title else { return }
        let attrs = AgentRunAttributes(sessionId: sid, computerId: computerId, chatTitle: hideDetails() ? "Chat" : title,
                                       computerName: computerName)
        let state = AgentRunAttributes.ContentState(phase: phase, step: step, callId: callId, severity: severity,
                                                     steps: steps[sid] ?? 0, startedAt: now)
        if let a = try? ActivityKit.Activity<AgentRunAttributes>.request(attributes: attrs, content: ActivityContent(state: state, staleDate: now.addingTimeInterval(15 * 60))) {
            activities[sid] = a
        }
    }

    private func end(_ sid: String, phase: AgentRunAttributes.Phase, step: String) {
        lastUpdate[sid] = nil
        let count = steps.removeValue(forKey: sid) ?? 0
        guard let a = activities.removeValue(forKey: sid) else { return }
        var state = a.content.state
        state.phase = phase
        state.step = step
        state.callId = nil
        state.steps = count
        Task { await a.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(10 * 60))) }
    }
}
