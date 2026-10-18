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

        init(phase: Phase, step: String, callId: String?, severity: String?, steps: Int, startedAt: Date) {
            self.phase = phase
            self.step = step
            self.callId = callId
            self.severity = severity
            self.steps = steps
            self.startedAt = startedAt
        }

        /// Pushes from the relay carry only the phase (and an approval's call id
        /// and risk): everything else falls back, and an empty step reads as the
        /// phase's generic line (`displayStep`).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            phase = try c.decode(Phase.self, forKey: .phase)
            step = try c.decodeIfPresent(String.self, forKey: .step) ?? ""
            callId = try c.decodeIfPresent(String.self, forKey: .callId)
            severity = try c.decodeIfPresent(String.self, forKey: .severity)
            steps = try c.decodeIfPresent(Int.self, forKey: .steps) ?? 0
            startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt) ?? .distantPast
        }

        /// The step line, or a generic one for the phase when a push left it empty.
        var displayStep: String {
            if !step.isEmpty { return step }
            switch phase {
            case .running: return "Working…"
            case .approval: return "A tool needs your approval"
            case .question: return "Your computer has a question"
            case .done: return "Finished"
            case .failed: return "Stopped with an error"
            }
        }

        /// Whether `startedAt` is real (a push doesn't know it).
        var hasStart: Bool { startedAt > Date(timeIntervalSince1970: 0) }
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

/// Allow from the Lock Screen: iOS asks for Face ID or the passcode first,
/// since allowing a tool runs it on the computer. (Deny and Stop only stop
/// something, so they stay one tap.) Before this, Allow on a locked phone
/// quietly did nothing.
struct AllowToolIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Allow a tool call"
    static var description = IntentDescription("Allow the tool call your computer is waiting on.")
    static var isDiscoverable = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Chat") var sessionId: String
    @Parameter(title: "Tool call") var callId: String

    init() {}

    init(sessionId: String, callId: String) {
        self.sessionId = sessionId
        self.callId = callId
    }

    func perform() async throws -> some IntentResult {
        await IntentRouter.approve?(sessionId, callId, true)
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
