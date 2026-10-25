import Foundation
import NekkoProtocol

/// What the step-up sheet is asked to confirm (SK-6): the action in plain
/// words, the computer, and the challenge it just issued. Shown again, with
/// `problem`, when the computer turned an answer down.
public struct StepUpRequest: Equatable, Sendable, Identifiable {
    public let id: UUID
    /// *Switch “Refactor auth” to YOLO on Studio*.
    public let action: String
    public let computer: String
    public let challenge: StepUpChallenge
    /// 1 for the first ask, then up to `StepUp.maxAttempts`.
    public let attempt: Int
    /// Why the last answer was turned down, in the computer's plain words.
    public let problem: String?

    public init(id: UUID = UUID(), action: String, computer: String, challenge: StepUpChallenge, attempt: Int = 1,
                problem: String? = nil) {
        self.id = id
        self.action = action
        self.computer = computer
        self.challenge = challenge
        self.attempt = attempt
        self.problem = problem
    }
}

/// Shows the step-up sheet and returns the owner's answer, or nil when they
/// cancel. The app's sheet in the app; a software authenticator in tests.
public typealias StepUpPrompt = @MainActor (StepUpRequest) async -> StepUpProof?

/// A safety exit this phone just used on a computer (SK-8), so the banner
/// can say why the connection ended instead of "removed this iPhone".
public struct SafetyExit: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// `remote:stop`: remote access is off on the computer until the owner turns it on there.
        case stoppedRemote
        /// `app:quit`: Nekko Agent quit on the computer.
        case quit
    }

    public let computerId: String
    public let kind: Kind
    /// Milliseconds since the epoch.
    public let at: Int64

    public init(computerId: String, kind: Kind, at: Int64) {
        self.computerId = computerId
        self.kind = kind
        self.at = at
    }
}

/// A computer this phone signed out of while it couldn't tell the computer
/// (SK-8): everything else about it is forgotten; this keeps only what it
/// takes to connect once and send `device:signOut`. Kept in the Keychain
/// (`SecureStore`), dropped once the computer has heard or no longer knows
/// this phone.
struct PendingSignOut: Codable, Equatable {
    var computerId: String
    var name: String
    var relayUrl: String
    var alts: [String]
    var room: String
    var key: String
    var keyHex: String
    var at: Int64
}

extension StepUp {
    /// The guarded action in plain words for the sheet (spec: *Switch
    /// "Refactor auth" to YOLO on Philip's Mac Studio*). `chatTitle` names a
    /// chat by its id when the phone knows it.
    public static func actionName(channel: String, args: [JSONValue], computer: String,
                                  chatTitle: (String) -> String? = { _ in nil }) -> String {
        func mode(_ raw: String?) -> String? {
            switch raw.flatMap(PcSettings.ChatMode.init(rawValue:)) {
            case .ask?: return "Ask"
            case .guardrails?: return "Guardrails"
            case .yolo?: return "YOLO"
            case nil: return nil
            }
        }
        switch channel {
        case Channels.sessionSetOptions:
            let title = args.first?.string.flatMap(chatTitle).flatMap { $0.isEmpty ? nil : $0 }
            let chat = title.map { "“\($0)”" } ?? "this chat"
            if let m = mode(args.dropFirst().first?.str("mode")) { return "Switch \(chat) to \(m) on \(computer)" }
            return "Change \(chat) on \(computer)"
        case Channels.settingsUpdate:
            if let m = mode(args.first?.str("defaultChatMode")) { return "Make \(m) the default for new chats on \(computer)" }
            return "Change the settings on \(computer)"
        default:
            if channel.hasPrefix("security:") { return "Add a security key or passkey on \(computer)" }
            return "Confirm this on \(computer)"
        }
    }
}
