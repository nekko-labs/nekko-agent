import ActivityKit
import AppIntents
import Foundation

/// A chat running on the computer, on the Lock Screen and in the Dynamic
/// Island. Shared by the app (which starts and updates it from the relay's
/// events) and the widget extension (which draws it). Content stays coarse on
/// purpose: a step label and what the computer is waiting for, never the
/// conversation, since the Lock Screen is visible without unlocking.
struct AgentRunAttributes: ActivityAttributes {
    enum Phase: String, Codable, Hashable {
        case running, approval, question, done, failed
    }

    struct ContentState: Codable, Hashable {
        var phase: Phase
        /// "Thinking…", "Run npm test", "Edit src/app.ts" (tool label, or a generic word with the app lock on).
        var step: String
        /// The tool call waiting for approval, so the buttons can answer it.
        var callId: String?
        /// low / medium / high (the computer's guardrail rating).
        var severity: String?
        var steps: Int
        var startedAt: Date
    }

    var sessionId: String
    var computerId: String
    var chatTitle: String
    var computerName: String
}

/// Where the intents below hand their work in the app's process. Nil in the
/// widget extension, where the buttons are drawn but never run.
@MainActor
enum IntentRouter {
    static var approve: ((_ sessionId: String, _ callId: String, _ allow: Bool) async -> Void)?
    static var stop: ((_ sessionId: String) async -> Void)?
}

/// Allow or deny the waiting tool call from the Lock Screen or the Dynamic
/// Island. A `LiveActivityIntent` runs in the app's process (iOS launches it in
/// the background if needed), which holds the relay connection.
struct AnswerApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Answer a tool approval"
    static var description = IntentDescription("Allow or deny the tool call your computer is waiting on.")
    static var isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String
    @Parameter(title: "Tool call") var callId: String
    @Parameter(title: "Allow") var allow: Bool

    init() {}

    init(sessionId: String, callId: String, allow: Bool) {
        self.sessionId = sessionId
        self.callId = callId
        self.allow = allow
    }

    func perform() async throws -> some IntentResult {
        await IntentRouter.approve?(sessionId, callId, allow)
        return .result()
    }
}

struct StopRunIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop a running chat"
    static var isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.stop?(sessionId)
        return .result()
    }
}
