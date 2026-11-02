import ActivityKit
import AppIntents
import Foundation
import NekkoProtocol

/// The one Live Activity for all of the computer's chats, on the Lock Screen
/// and in the Dynamic Island. Shared by the app (which starts and updates it,
/// `RunActivities`) and the widget extension (which draws it, `LiveCardView`).
/// The state and its rules, including the tolerant decoder for relay pushes,
/// are `LiveCardState` in NekkoProtocol.
struct NekkoCardAttributes: ActivityAttributes, Equatable {
    typealias ContentState = LiveCardState

    var computerId: String
    var computerName: String
    /// What the card draws (icon-only chips at Minimal, the reply line at Detailed).
    /// Fixed for the card's life: a level change ends the card and starts a new one.
    var level: LiveLevel
}

/// Where the intents below hand their work in the app's process. Nil in the
/// widget extension, where the buttons are drawn but never run.
@MainActor
enum IntentRouter {
    static var approve: (@MainActor @Sendable (_ sessionId: String, _ callId: String, _ allow: Bool) async -> Void)?
    static var stop: (@MainActor @Sendable (_ sessionId: String) async -> Void)?
    // The card's buttons.
    static var focus: (@MainActor @Sendable (_ sessionId: String) async -> Void)?
    static var nextPage: (@MainActor @Sendable (_ sessionId: String) async -> Void)?
    static var dismiss: (@MainActor @Sendable (_ sessionId: String) async -> Void)?
    static var talk: (@MainActor @Sendable (_ sessionId: String) async -> Void)?
    static var cancelTalk: (@MainActor @Sendable () async -> Void)?
}

/// Allow or deny the waiting tool call from the Lock Screen or the Dynamic
/// Island. A `LiveActivityIntent` runs in the app's process (iOS launches it in
/// the background if needed), which holds the relay connection.
struct AnswerApprovalIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Answer a tool approval"
    static let description = IntentDescription("Allow or deny the tool call your computer is waiting on.")
    static let isDiscoverable = false

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
    static let title: LocalizedStringResource = "Allow a tool call"
    static let description = IntentDescription("Allow the tool call your computer is waiting on.")
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

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
    static let title: LocalizedStringResource = "Stop a running chat"
    static let isDiscoverable = false

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
    static let title: LocalizedStringResource = "Show a chat on the card"
    static let isDiscoverable = false

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
    static let title: LocalizedStringResource = "Show more chats on the card"
    static let isDiscoverable = false

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
    static let title: LocalizedStringResource = "Remove a finished chat from the card"
    static let isDiscoverable = false

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.dismiss?(sessionId)
        return .result()
    }
}

/// The mic (Detailed), and "Send to" while listening (a second tap sends now):
/// listens until the first pause and sends the words to the chat (`TalkRunner`).
/// Face ID or the passcode first, since what is said is sent to the computer.
/// On iOS 17, without `AudioRecordingIntent`, the card's mic is a link that opens
/// the chat listening instead (`LiveCardView.listenURL`).
struct TalkToChatIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Talk to a chat"
    static let isDiscoverable = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Chat") var sessionId: String

    init() {}

    init(sessionId: String) { self.sessionId = sessionId }

    func perform() async throws -> some IntentResult {
        await IntentRouter.talk?(sessionId)
        return .result()
    }
}

/// iOS 18 lets this intent start recording while the app is in the background; iOS
/// stops the recording unless a Live Activity is up, and the card it was tapped on is.
@available(iOS 18, *)
extension TalkToChatIntent: AudioRecordingIntent {}

/// Cancel while listening: nothing is sent.
struct CancelTalkIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop listening"
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        await IntentRouter.cancelTalk?()
        return .result()
    }
}
