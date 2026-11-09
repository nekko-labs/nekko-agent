import Foundation
import NekkoProtocol

/// Deterministic, computer-scoped commands. Never falls back to a focused chat.
@MainActor
public final class NekkoVoiceDispatcher {
    public struct Target: Equatable, Sendable {
        public var id: String
        public var name: String
        public var archived: Bool
        public init(id: String, name: String, archived: Bool = false) {
            self.id = id; self.name = name; self.archived = archived
        }
    }
    public struct Context: Sendable {
        public var computerId: String
        public var computerName: String
        public var online: Bool
        public var denied = false
        public var loaded: Bool
        public var card: LiveCardState
        public var targets: [Target]
        public init(computerId: String, computerName: String, online: Bool, loaded: Bool, card: LiveCardState, targets: [Target]) {
            self.computerId = computerId; self.computerName = computerName
            self.online = online; self.loaded = loaded; self.card = card; self.targets = targets
        }
    }
    public enum Result: Equatable {
        case message(String)
        case send(computerId: String, sessionId: String, text: String)
    }
    private struct Pending {
        var computerId: String
        var target: Target
        var text: String
        var expires: Date
    }
    private var pending: Pending?
    public init() {}
    public func cancel() { pending = nil }

    /// Grammar: status; send to <exact chat name> saying <message>;
    /// confirm send to <same exact name> saying <same exact message>; cancel.
    /// A colon is also accepted in place of the spoken delimiter.
    public func dispatch(_ speech: String, context c: Context, now: Date = .now) -> Result {
        guard !c.denied else {
            cancel()
            return .message("Not sent. This phone is no longer authorized. Open app.")
        }
        let words = speech.trimmingCharacters(in: .whitespacesAndNewlines)
        let command = words.lowercased()
        if ["cancel", "no", "never mind"].contains(command) {
            cancel()
            return .message("Cancelled. Nothing sent.")
        }
        if ["status", "what is happening", "what is happening?", "agent status"].contains(command) {
            cancel()
            let counts = c.card.counts ?? Dictionary(c.card.chats.map { ($0.state.rawValue, 1) }, uniquingKeysWith: +)
            let prefix = c.online && c.loaded ? "" : "Offline or stale. Last known "
            let partial = c.card.counts == nil && c.card.more > 0 ? " Partial counts; more agents are not included." : ""
            return .message("\(prefix)\(c.computerName): \(counts["working", default: 0]) Building, \(counts["needsYou", default: 0]) Need input, \(counts["done", default: 0]) Done, \(counts["watching", default: 0]) Watching, \(counts["failed", default: 0]) Failed.\(partial)")
        }
        let confirming = command.hasPrefix("confirm send to ")
        let prefix = confirming ? "confirm send to " : "send to "
        let delimiters = [words.range(of: ":"), words.range(of: " saying ", options: .caseInsensitive)].compactMap { $0 }
        guard command.hasPrefix(prefix), let delimiter = delimiters.min(by: { $0.lowerBound < $1.lowerBound }) else {
            cancel()
            return .message("Not sent. Say status, or send to an exact chat name, saying, then the message. Open app for approvals, stopping work, or other actions.")
        }
        let name = String(words[words.index(words.startIndex, offsetBy: prefix.count)..<delimiter.lowerBound]).trimmingCharacters(in: .whitespaces)
        let text = String(words[delimiter.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = c.targets.filter { !$0.archived && !$0.name.isEmpty && $0.name.compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
        guard c.loaded, matches.count == 1, let target = matches.first, !text.isEmpty else {
            cancel()
            return .message("Not sent. Target missing, ambiguous, or unavailable. Open app to choose the exact chat and message.")
        }
        if confirming {
            let old = pending
            cancel()
            guard let old, old.expires > now, old.computerId == c.computerId, old.target == target, old.text == text else {
                return .message("Not sent. Confirmation expired or target/message changed. Start again with send to, or open app.")
            }
            return .send(computerId: c.computerId, sessionId: target.id, text: text)
        }
        pending = Pending(computerId: c.computerId, target: target, text: text, expires: now.addingTimeInterval(60))
        // Do not copy the full transcript or target name into the Lock Screen payload.
        return .message("Nothing sent yet. To confirm, say confirm send to, then the same exact chat name, saying, and message. Or say cancel. Open app to review.")
    }
}

/// Snapshot checks shared by main-actor capture and delivery. Offline is allowed; denied is not.
public enum NekkoVoiceScope {
    public static func permits(computerId: String, activeId: String?, state: RelayState) -> Bool {
        activeId == computerId && state != .denied
    }
    public static func permitsDelivery(computerId: String, activeId: String?, cardComputerId: String?,
                                       state: RelayState, targets: [NekkoVoiceDispatcher.Target],
                                       sessionId: String, confirmedName: String?) -> Bool {
        permits(computerId: computerId, activeId: activeId, state: state) && cardComputerId == computerId &&
        targets.contains { $0.id == sessionId && $0.name == confirmedName && !$0.archived }
    }
}

/// Own the caller, not a lookup into mutable selection after a capability await.
@MainActor
public final class NekkoVoiceComputer {
    public let id: String
    private let caller: any Caller
    private let allowed: () -> Bool
    public init(id: String, caller: any Caller, allowed: @escaping () -> Bool) {
        self.id = id; self.caller = caller; self.allowed = allowed
    }
    public func call(_ channel: String, _ args: [JSONValue] = [], timeout: TimeInterval? = nil) async throws -> JSONValue {
        guard allowed() else { throw CancellationError() }
        return try await caller.call(channel, args, timeout: timeout)
    }
}

/// A generation may cancel during preparation. Commit is synchronous and must be
/// called immediately before persistence, with no suspension between it and the write.
@MainActor
public final class NekkoVoiceCommit {
    private let current: () -> Bool
    var onCommit: () -> Void = {}
    public private(set) var committed = false
    init(current: @escaping () -> Bool) { self.current = current }
    public var isCurrent: Bool { current() }
    public func commit(if allowed: () -> Bool = { true }) -> Bool {
        guard !committed, current(), allowed() else { return false }
        committed = true
        onCommit()
        return true
    }
}

/// Capture has a single owner until it drains. A cancelled generation can neither
/// dispatch late words nor overwrite a newer result, including during startup.
@MainActor
public final class NekkoVoiceRunner {
    public var capture: () async throws -> String = { "" }
    public var finish: () -> Void = {}
    public var discard: () -> Void = {}
    /// Read-only routes (e.g. status). Persistence must use routeWithCommit.
    public var route: (String) async throws -> String = { _ in "Not sent. Open app." }
    public var routeWithCommit: ((String, NekkoVoiceCommit) async throws -> String)?
    public var show: (Bool, String) -> Void = { _, _ in }
    public var onCancel: () -> Void = {}
    /// The card's words for a capture or delivery failure that has a known remedy
    /// (no microphone permission yet); nil keeps the generic failure line.
    public var describe: (Error) -> String? = { _ in nil }
    public private(set) var busy = false
    /// The microphone phase (from the tap until the words are captured).
    public var isListening: Bool { listening }
    private var listening = false
    private var heardSpeechShown = false
    private var generation = 0
    private var delivery: NekkoVoiceCommit?
    /// Processing remains visible, but is cancellable until synchronous persistence.
    public var canCancel: Bool { busy && delivery?.isCurrent == true && delivery?.committed != true }
    public init() {}
    public func talk() async {
        guard !busy else { if listening { finish() }; return }
        busy = true
        listening = true
        generation += 1
        let token = generation
        let permit = NekkoVoiceCommit { [weak self] in self?.busy == true && self?.generation == token }
        permit.onCommit = { [weak self] in self?.show(true, LiveCardVoice.sending) }
        delivery = permit
        heardSpeechShown = false
        defer { busy = false; listening = false; delivery = nil }
        show(true, LiveCardVoice.listening)
        do {
            let text = try await capture().trimmingCharacters(in: .whitespacesAndNewlines)
            guard token == generation else { return }
            listening = false
            guard !text.isEmpty else { show(false, "No words heard. Nothing sent."); return }
            // Keep the card alive and retain local voice state through push updates.
            show(true, LiveCardVoice.processing)
            let reply: String
            if let routeWithCommit { reply = try await routeWithCommit(text, permit) }
            else { reply = try await route(text) }
            guard token == generation else { return }
            show(false, reply)
        } catch {
            guard token == generation else { return }
            // Recognizer/server diagnostics may contain captured words or credentials.
            // Keep raw errors off the Lock Screen, as with the transcript itself.
            show(false, describe(error) ?? "Not sent. Voice capture or delivery failed. Open app to review.")
        }
    }
    /// Speech started while listening: the card says it is hearing, once per capture.
    public func heardSpeech() {
        guard listening, !heardSpeechShown else { return }
        heardSpeechShown = true
        show(true, LiveCardVoice.hearing)
    }
    public func finishListening() { if listening { finish() } }
    public func cancel(message: String = "Cancelled. Nothing sent.") {
        // Once persisted, an outbox delivery cannot honestly be recalled.
        guard delivery?.committed != true else { return }
        generation += 1
        listening = false
        onCancel()
        discard()
        show(false, message)
    }
}
