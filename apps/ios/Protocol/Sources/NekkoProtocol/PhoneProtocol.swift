import Foundation

/// The phone protocol version (IO-32): sent in the HELLO, compared with the
/// computer's in its welcome (`REMOTE_PROTOCOL_VERSION` in
/// packages/shared/src/remote.ts, `PROTOCOL_VERSION` in nekko-remote). A
/// computer from before the field counts as 1. Version 4 adds the relay
/// challenge (replay protection, see `RelayClient`).
public enum PhoneProtocol {
    public static let version = 4
    /// What a HELLO says to a computer that never challenged this phone (from before version 4).
    public static let legacyVersion = 3

    /// What the welcome says, or 1 for a computer that sends nothing.
    public static func of(welcome frame: JSONValue) -> Int {
        guard let n = frame.long("protocol"), n > 0, n < 10_000 else { return 1 }
        return Int(n)
    }
}

/// Which side to update when the phone and the computer speak different versions.
public enum ProtocolCheck: Equatable, Sendable {
    case same
    /// The computer is older: update Nekko Agent there.
    case updateComputer
    /// This app is older: update it from the App Store.
    case updatePhone

    /// `computer` is nil until the computer has welcomed this phone.
    public static func compare(phone: Int = PhoneProtocol.version, computer: Int?) -> ProtocolCheck {
        guard let computer, computer != phone else { return .same }
        return computer < phone ? .updateComputer : .updatePhone
    }

    /// The banner's sentence, or nil when nothing needs updating.
    public func message(computer: String) -> String? {
        switch self {
        case .same:
            return nil
        case .updateComputer:
            return "Nekko Agent on \(computer) is older than this app. Update it on the computer to use everything here."
        case .updatePhone:
            return "This app is older than Nekko Agent on \(computer). Update Nekko Agent from the App Store to use everything it offers."
        }
    }
}

/// What a content-free push is about (IO-30). The phone asks its relay for only
/// the kinds switched on; `test` is *Send a test notification*.
public enum PushKind: String, CaseIterable, Sendable {
    case needsYou = "needs-you", finished, failed, test

    /// The kinds a person can switch on or off.
    public static let choosable: [PushKind] = [.needsYou, .finished, .failed]

    /// The kind of notification an agent event would cause, if any.
    public static func of(_ e: AgentEvent) -> PushKind? {
        switch e {
        case .approvalRequired, .question: return .needsYou
        case .done: return .finished
        case .error(_, let message): return ["stopped", "aborted"].contains(message.lowercased()) ? nil : .failed
        default: return nil
        }
    }
}

/// A plain (unsealed) frame from the relay itself, not the computer.
public enum RelayControl: Equatable, Sendable {
    /// The answer to `register-push`: whether this relay can push to this phone.
    case pushRegistered(delivers: Bool)
    /// An approval or a question was handled: remove that chat's needs-you notification.
    case dismiss(tag: String)

    public static func parse(_ frame: JSONValue) -> RelayControl? {
        switch frame.str("type") {
        case "push-registered":
            return .pushRegistered(delivers: frame["delivers"]?.bool ?? false)
        case "dismiss":
            guard let tag = frame.str("tag"), tag.count == 32, tag.allSatisfy(\.isHexDigit) else { return nil }
            return .dismiss(tag: tag)
        default:
            return nil
        }
    }
}

/// How *Send a test notification* reached (or would reach) this phone.
public enum TestPushResult: Equatable, Sendable {
    /// The relay holds an Apple push key and was asked to push to this phone.
    case relay
    /// Shown on the phone itself, with why the relay couldn't push.
    case local(LocalReason)

    public enum LocalReason: Equatable, Sendable {
        /// The relay said it has no push key (a relay on your computer or tailnet).
        case relayCannotPush
        /// The relay didn't say (an older relay).
        case relayDidNotSay
        /// This iPhone has no push token (notifications off, or the simulator).
        case noToken
        /// The computer doesn't know `push:test` yet.
        case computerTooOld
    }

    /// A computer from before `push:test` refuses it as a channel a phone may not call.
    public static func unknownToComputer(_ error: String) -> Bool {
        error.contains("channel-denied") || error.hasPrefix("Unknown channel")
    }

    /// The decision, from what the store knows after asking the computer.
    public static func decide(computerAnswered: Bool, hasToken: Bool, relayDelivers: Bool?) -> TestPushResult {
        if !computerAnswered { return .local(.computerTooOld) }
        if !hasToken { return .local(.noToken) }
        switch relayDelivers {
        case true?: return .relay
        case false?: return .local(.relayCannotPush)
        case nil: return .local(.relayDidNotSay)
        }
    }

    /// What Settings says under the button.
    public func message(computer: String, relayHost: String) -> String {
        switch self {
        case .relay:
            return "Sent from \(computer) through \(relayHost) by Apple push. It should arrive in a few seconds."
        case .local(.relayCannotPush):
            return "\(computer) answered, but \(relayHost) has no Apple push key, so this one was shown by the app. Notifications arrive while the app is open or was used recently."
        case .local(.relayDidNotSay):
            return "\(computer) answered, but \(relayHost) didn’t say whether it can push, so this one was shown by the app."
        case .local(.noToken):
            return "\(computer) answered, but this iPhone isn’t registered for push (notifications may be off), so this one was shown by the app."
        case .local(.computerTooOld):
            return "Nekko Agent on \(computer) is too old to send a test, so this one was shown by the app. Update it on the computer."
        }
    }
}
