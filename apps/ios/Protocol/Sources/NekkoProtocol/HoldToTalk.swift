import Foundation

/// Hold-to-talk dictation (IO-28): press the microphone to record, let go to
/// stop. Pure, so the races are tested on Linux: a release that comes before
/// the recorder has started (it starts asynchronously), a tap too short to say
/// anything, and the first press that has to ask for the microphone.
public struct HoldToTalk: Equatable, Sendable {
    /// Shorter holds are taken as a tap: nothing is transcribed.
    public static let minSeconds: TimeInterval = 0.4

    public enum Permission: Sendable { case undetermined, granted, denied }

    public enum Action: Equatable, Sendable {
        case none
        /// Ask for the microphone only; the person holds again to talk.
        case askPermission
        case start
        /// Stop and transcribe.
        case finish
        /// Stop and throw the recording away (too short, or let go before it began).
        case discard
    }

    private var pressedAt: Date?
    private var startedAt: Date?
    private var releasedEarly = false

    public init() {}

    public var holding: Bool { pressedAt != nil }

    public mutating func press(at now: Date, permission: Permission) -> Action {
        guard pressedAt == nil, startedAt == nil else { return .none }
        switch permission {
        case .undetermined:
            // iOS shows its prompt now; the finger is up by the time it's answered.
            return .askPermission
        case .denied:
            return .none
        case .granted:
            pressedAt = now
            releasedEarly = false
            return .start
        }
    }

    /// The recorder is running.
    public mutating func didStart(at now: Date) -> Action {
        guard pressedAt != nil else { return .none }
        if releasedEarly {
            self = HoldToTalk()
            return .discard
        }
        startedAt = now
        return .none
    }

    /// The recorder couldn't start (an error is shown).
    public mutating func failedToStart() { self = HoldToTalk() }

    public mutating func release(at now: Date) -> Action {
        guard pressedAt != nil else { return .none }
        guard let startedAt else {
            releasedEarly = true
            return .none
        }
        self = HoldToTalk()
        return now.timeIntervalSince(startedAt) < Self.minSeconds ? .discard : .finish
    }
}
