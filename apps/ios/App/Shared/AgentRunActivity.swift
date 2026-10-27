import ActivityKit
import AppIntents
import Foundation
import NekkoProtocol

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

/// The one Live Activity for all of the computer's chats (replaces
/// `AgentRunAttributes`, one per chat, in Task 3.3). The state and its rules,
/// including the tolerant decoder for relay pushes, are `LiveCardState` in
/// NekkoProtocol.
struct NekkoCardAttributes: ActivityAttributes {
    typealias ContentState = LiveCardState

    var computerId: String
    var computerName: String
    /// What the card draws (icon-only chips at Minimal, the mic at Detailed).
    /// Fixed for the card's life: a level change ends the card and starts a new one.
    var level: LiveLevel
}

/// Where the intents below hand their work in the app's process. Nil in the
/// widget extension, where the buttons are drawn but never run.
@MainActor
enum IntentRouter {
    static var approve: ((_ sessionId: String, _ callId: String, _ allow: Bool) async -> Void)?
    static var stop: ((_ sessionId: String) async -> Void)?
    // The card's buttons; set in the app by Task 3.3 (focus, nextPage, dismiss) and 5.1 (talk).
    static var focus: ((_ sessionId: String) async -> Void)?
    static var nextPage: ((_ sessionId: String) async -> Void)?
    static var dismiss: ((_ sessionId: String) async -> Void)?
    static var talk: ((_ sessionId: String) async -> Void)?
    static var cancelTalk: (() async -> Void)?
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

/// A chip on the card: bring that chat up top.
struct FocusChatIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Show a chat on the card"
    static var isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.focus?(sessionId)
        return .result()
    }
}

/// The "+N" chip: step the strip to the next chats. The strip shows the page
/// that holds the focused chat and only the view knows how many chips fit, so
/// the chip names the chat that starts the next page (the first one again after
/// the last page) and the app focuses it.
struct NextPageIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Show more chats on the card"
    static var isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.nextPage?(sessionId)
        return .result()
    }
}

/// The close button under a finished chat: take it off the card.
struct DismissChatIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Remove a finished chat from the card"
    static var isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.dismiss?(sessionId)
        return .result()
    }
}

/// The mic, and "Send to" while listening (a second tap sends). A placeholder
/// that Task 5.1 fills in with the recording; it needs Face ID or the passcode,
/// since what is said is sent to the computer.
struct TalkToChatIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Talk to a chat"
    static var isDiscoverable = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.talk?(sessionId)
        return .result()
    }
}

/// Cancel while listening: nothing is sent.
struct CancelTalkIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop listening"
    static var isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await IntentRouter.cancelTalk?()
        return .result()
    }
}
