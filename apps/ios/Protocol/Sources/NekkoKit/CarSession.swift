import Foundation
import NekkoProtocol
import Observation

// Nekko in CarPlay without CarPlay: what the driver's words do, the read-back that
// guards every change, the Results list, and the listen → act → speak loop. The
// app's CarPlay scene draws templates from it and supplies audio and actions, so
// all of this runs in the Linux tests. Design: nekko-designs/carplay-design.html.

/// A chat as the car sees it: state and short facts, never what the agent wrote,
/// except `reply`, which is only ever spoken.
public struct CarChat: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var state: LiveChatState
    /// The current step ("Allow: run npm test", "Editing auth.spec.ts").
    public var step: String
    /// The approval waiting, when it needs you for one (nil for a question).
    public var callId: String?
    /// low / medium / high, the computer's guardrail rating of `callId`.
    public var severity: String?
    public var computerId: String
    public var computerName: String
    /// The latest reply, flattened to plain text (spoken only).
    public var reply: String
    public var startedAt: Date?
    /// On the computer the phone can act on now (the active one).
    public var actionable: Bool

    public init(id: String, title: String, state: LiveChatState, step: String = "", callId: String? = nil, severity: String? = nil,
                computerId: String, computerName: String, reply: String = "", startedAt: Date? = nil, actionable: Bool = true) {
        self.id = id; self.title = title; self.state = state; self.step = step; self.callId = callId; self.severity = severity
        self.computerId = computerId; self.computerName = computerName; self.reply = reply; self.startedAt = startedAt
        self.actionable = actionable
    }
}

/// How a send ended: on the computer, or saved in the outbox until it is back.
public enum CarDelivery: Equatable, Sendable { case delivered, queued }

/// What the car can do. The app wires these to the outbox and the relay.
public struct CarActions {
    public var send: (_ chatId: String, _ text: String) async throws -> CarDelivery
    public var newChat: (_ text: String) async throws -> CarDelivery
    public var answer: (_ chatId: String, _ callId: String, _ allow: Bool) async throws -> Void
    public var stop: (_ chatId: String) async throws -> Void
    /// Allowing a tool needs an unlocked iPhone (the app's rule outside the app).
    public var unlocked: () -> Bool
    /// The active computer's name, for "New chat on Studio Mac"; nil when none is paired.
    public var computerName: () -> String?

    public init(send: @escaping (String, String) async throws -> CarDelivery,
                newChat: @escaping (String) async throws -> CarDelivery,
                answer: @escaping (String, String, Bool) async throws -> Void,
                stop: @escaping (String) async throws -> Void,
                unlocked: @escaping () -> Bool, computerName: @escaping () -> String?) {
        self.send = send; self.newChat = newChat; self.answer = answer; self.stop = stop
        self.unlocked = unlocked; self.computerName = computerName
    }
}

/// One row of the Results list: what a command did and how it ended, in words.
public struct CarResult: Equatable, Sendable, Identifiable {
    public enum Outcome: String, Equatable, Sendable {
        /// Done (sent, allowed, stopped).
        case done
        /// Saved, waiting for the computer.
        case waiting
        /// Did not happen, and why is in `detail`.
        case failed
        /// Only information (status, a read).
        case info
    }
    public let id: Int
    public var title: String
    public var detail: String
    public var outcome: Outcome
    public var chatId: String?
    public var at: Date
    /// What a tap on the row says again.
    public var spoken: String
    /// A send's chat had this reply when it was sent: a different one is its answer.
    var replyBefore: String?
    /// The answer arrived (`detail` says so; a tap reads it).
    public var replyReady = false
}

/// What Nekko says back, and whether it listens again for an answer.
public struct CarReply: Equatable, Sendable {
    public enum Next: Equatable, Sendable {
        /// Done: the sheet closes.
        case end
        /// A read-back or a choice is open: listen for the answer.
        case listen
        /// Sent in a chat's Talk: wait for its answer, speak it, then listen again.
        case awaitReply(chatId: String)
    }
    public var speech: String
    public var next: Next
    /// A read-back is open (the voice sheet says "Say yes to …").
    public var confirming: Bool
    public init(_ speech: String, next: Next = .end, confirming: Bool = false) {
        self.speech = speech; self.next = next; self.confirming = confirming
    }
}

/// What a read-back would do, for the sheet's "Say yes to …".
public enum CarConfirm: String, Equatable, Sendable { case send, start, allow, deny, stop }

/// The voice sheet's states (`CPVoiceControlState` identifiers in the app).
public enum CarVoicePhase: String, Equatable, Sendable {
    case listening, working, confirming, speaking, done
}

@MainActor @Observable
public final class CarSession {
    /// A read-back left unanswered this long is dropped.
    public static let confirmSeconds: TimeInterval = 30
    /// Results kept for this drive.
    public static let maxResults = 30
    /// How long a chat's Talk waits for its answer before it says the work goes on.
    public static let replyWait: TimeInterval = 120
    /// A conversation in a chat's Talk ends after this many turns, so a forgotten sheet
    /// does not keep the microphone.
    public static let maxTurns = 8

    public private(set) var results: [CarResult] = []
    /// What the read-back waiting for yes or no would do: the sheet says "Say yes to send".
    public private(set) var confirming: CarConfirm?

    @ObservationIgnored public var chats: () -> [CarChat] = { [] }
    @ObservationIgnored public var actions: CarActions
    @ObservationIgnored private var pending: Pending?
    @ObservationIgnored private var choice: Choice?
    @ObservationIgnored private var lastSpoken = ""
    @ObservationIgnored private var nextId = 1
    @ObservationIgnored private let now: () -> Date

    private enum Action: Equatable {
        case send(chatId: String, text: String)
        case newChat(text: String)
        case answer(chatId: String, callId: String, allow: Bool)
        case stop(chatId: String)
    }
    private struct Pending { var action: Action; var expires: Date }
    /// "Which one?": the command waits for a pick among `ids`.
    private struct Choice { var ids: [String]; var command: CarCommand; var expires: Date }

    public init(actions: CarActions, now: @escaping () -> Date = Date.init) {
        self.actions = actions
        self.now = now
    }

    /// The drive is over (CarPlay disconnected): forget open questions; Results stay
    /// until the next connection starts a new list.
    public func reset() {
        pending = nil
        choice = nil
        confirming = nil
    }

    public func startDrive() {
        reset()
        results = []
    }

    // MARK: One utterance

    /// What `words` do. `inChat`: Talk was opened on that chat's screen.
    public func handle(_ words: String, inChat: String? = nil) async -> CarReply {
        let command = parseCarCommand(words, inChat: inChat != nil)
        if let p = pending {
            pending = nil
            confirming = nil
            guard p.expires > now() else { return say("That timed out, so nothing changed.") }
            switch command {
            case .yes: return await run(p.action, inChat: inChat)
            case .no: return say("OK, nothing changed.")
            case .again:
                pending = p
                confirming = kind(of: p.action)
                return CarReply(lastSpoken, next: .listen, confirming: true)
            default:
                // Anything else is a new command; the read-back is dropped, said once.
                let reply = await handle(command, inChat: inChat)
                return CarReply("Nothing changed. " + reply.speech, next: reply.next, confirming: reply.confirming)
            }
        }
        if let c = choice {
            choice = nil
            guard c.expires > now() else { return say("That timed out, so nothing changed.") }
            if case .pick(let n) = command {
                guard n >= 1, n <= c.ids.count else { return say("There are only \(c.ids.count). Nothing changed.") }
                return await handle(c.command, chatId: c.ids[n - 1], inChat: inChat)
            }
            if case .no = command { return say("OK, nothing changed.") }
            // A name instead of a number ("Billing"): match it among the choices.
            let names = c.ids.compactMap { id in chat(id).map { CarChatName(id: $0.id, title: $0.title) } }
            if case .one(let id) = matchCarChat(words, among: names) { return await handle(c.command, chatId: id, inChat: inChat) }
        }
        return await handle(command, inChat: inChat)
    }

    private func handle(_ command: CarCommand, inChat: String?) async -> CarReply {
        switch command {
        case .status: return status()
        case .again: return CarReply(lastSpoken.isEmpty ? "Nothing to repeat yet." : lastSpoken)
        case .yes, .pick: return say("There is nothing to answer right now. Say what's happening, or tell a chat something.")
        case .no: return say("OK.")
        case .unknown:
            return say("Sorry, I didn't get that. You can ask what's happening, or say tell, then a chat's name, then the message.")
        case .newChat(let text):
            guard let computer = actions.computerName() else { return say("No computer is paired yet.") }
            return confirm(.newChat(text: text), "Start a new chat on \(computer): \(text). Say yes to start it.")
        case .read(let name), .tell(let name, _), .allow(let name), .deny(let name), .stop(let name):
            switch resolve(name, for: command, inChat: inChat) {
            case .chat(let id): return await handle(command, chatId: id, inChat: inChat)
            case .reply(let reply): return reply
            }
        }
    }

    private enum Resolved { case chat(String), reply(CarReply) }

    /// The chat a command names, or what to say when it names none or several.
    private func resolve(_ name: String?, for command: CarCommand, inChat: String?) -> Resolved {
        let all = chats()
        guard let name else {
            if let inChat, all.contains(where: { $0.id == inChat }) { return .chat(inChat) }
            // "Allow" with one approval waiting needs no name; nor does "stop" with one chat working.
            let candidates: [CarChat]
            switch command {
            case .allow, .deny: candidates = all.filter { $0.state == .needsYou && $0.callId != nil }
            case .stop: candidates = all.filter { $0.state == .working || $0.state == .needsYou }
            case .read: candidates = all.filter { !$0.reply.isEmpty }.prefix(1).map { $0 }
            default: candidates = []
            }
            if candidates.count == 1 { return .chat(candidates[0].id) }
            if candidates.isEmpty {
                switch command {
                case .allow, .deny: return .reply(say("Nothing is waiting for an approval."))
                case .stop: return .reply(say("Nothing is working right now."))
                default: return .reply(say("Which chat? Say its name."))
                }
            }
            return .reply(ask(candidates.prefix(3).map(\.id), for: command))
        }
        let named = all.map { CarChatName(id: $0.id, title: $0.title) }
        switch matchCarChat(name, among: named) {
        case .one(let id): return .chat(id)
        case .several(let ids): return .reply(ask(ids, for: command))
        case .none: return .reply(say("I couldn't find a chat called \(name)."))
        }
    }

    private func ask(_ ids: [String], for command: CarCommand) -> CarReply {
        choice = Choice(ids: ids, command: command, expires: now().addingTimeInterval(Self.confirmSeconds))
        let names = ids.compactMap { chat($0)?.title }
        let list = names.enumerated().map { "\(ordinal($0.offset + 1)), \($0.element)" }.joined(separator: "; ")
        return CarReply("Which one? \(list).", next: .listen)
    }

    private func handle(_ command: CarCommand, chatId: String, inChat: String?) async -> CarReply {
        guard let c = chat(chatId) else { return say("That chat is gone.") }
        switch command {
        case .read:
            let text = c.reply.trimmingCharacters(in: .whitespacesAndNewlines)
            let speech = text.isEmpty ? "\(c.title) hasn't replied yet. \(stateSentence(c))" : "\(c.title) said: \(text)"
            log("Read \(c.title)", detail: c.state.word, outcome: .info, chatId: c.id, spoken: speech)
            return say(speech)
        case .tell(_, let message):
            guard c.actionable else { return say(notActionable(c)) }
            // In the chat's own Talk, a message goes straight in: the driver chose the chat
            // on screen, and the conversation is the point. Elsewhere it is read back first.
            if inChat == c.id { return await run(.send(chatId: c.id, text: message), inChat: inChat) }
            return confirm(.send(chatId: c.id, text: message), "Send to \(c.title): \(message). Say yes to send.")
        case .allow, .deny:
            let allow: Bool = { if case .allow = command { return true }; return false }()
            guard c.state == .needsYou, let callId = c.callId else {
                return say(c.state == .needsYou ? "\(c.title) is asking a question, not for an approval. It will wait for you."
                                                : "\(c.title) isn't waiting for an approval.")
            }
            guard c.actionable else { return say(notActionable(c)) }
            if allow {
                if c.severity == "high" {
                    log("Allow \(c.title)", detail: "High risk, not from the car", outcome: .failed, chatId: c.id,
                        spoken: "That step is high risk, so it can't be allowed from the car. It will wait for you.")
                    return say("That step is high risk, so it can't be allowed from the car. It will wait for you.")
                }
                guard actions.unlocked() else {
                    log("Allow \(c.title)", detail: "Needs iPhone unlocked", outcome: .failed, chatId: c.id,
                        spoken: "Allowing a tool needs your iPhone unlocked. It will keep waiting for you.")
                    return say("Allowing a tool needs your iPhone unlocked. It will keep waiting for you.")
                }
            }
            let step = stepName(c)
            return confirm(.answer(chatId: c.id, callId: callId, allow: allow),
                           "\(allow ? "Allow" : "Deny") \(step) in \(c.title)? Say yes to \(allow ? "allow" : "deny") it.")
        case .stop:
            guard c.state == .working || c.state == .needsYou else { return say("\(c.title) isn't working right now.") }
            guard c.actionable else { return say(notActionable(c)) }
            return confirm(.stop(chatId: c.id), "Stop \(c.title)? Its work so far stays in the chat. Say yes to stop it.")
        default:
            return await handle(command, inChat: inChat)
        }
    }

    private func confirm(_ action: Action, _ speech: String) -> CarReply {
        pending = Pending(action: action, expires: now().addingTimeInterval(Self.confirmSeconds))
        confirming = kind(of: action)
        return CarReply(remember(speech), next: .listen, confirming: true)
    }

    /// What the sheet shows during a read-back: the verb, never the words.
    private func kind(of action: Action) -> CarConfirm {
        switch action {
        case .send: return .send
        case .newChat: return .start
        case .answer(_, _, let allow): return allow ? .allow : .deny
        case .stop: return .stop
        }
    }

    /// A tap on the car's screen (Allow, Deny, Stop on a chat): the tap is the driver's
    /// own confirmation, so a read-back the command opens is answered at once. The rules
    /// it checks (unlocked to allow, never high risk, this computer) still apply.
    public func act(_ command: CarCommand, on chatId: String) async -> CarReply {
        pending = nil
        choice = nil
        let reply = await handle(command, chatId: chatId, inChat: chatId)
        guard let p = pending else { return reply }
        pending = nil
        confirming = nil
        return await run(p.action, inChat: nil)
    }

    // MARK: Doing it

    private func run(_ action: Action, inChat: String?) async -> CarReply {
        switch action {
        case .send(let id, let text):
            let c = chat(id)
            let name = c?.title ?? "the chat"
            do {
                let delivery = try await actions.send(id, text)
                let queued = delivery == .queued
                let speech = queued ? "Saved. It sends when \(c?.computerName ?? "the computer") is back." : "Sent to \(name)."
                var r = log("Sent to \(name)", detail: queued ? "Waiting to send · \(c?.computerName ?? "") is offline" : "Delivered",
                            outcome: queued ? .waiting : .done, chatId: id, spoken: speech)
                r.replyBefore = c?.reply ?? ""
                update(r)
                if inChat == id, !queued { return CarReply(remember(speech), next: .awaitReply(chatId: id)) }
                return say(speech)
            } catch {
                return failed("Send to \(name)", chatId: id, error)
            }
        case .newChat(let text):
            let computer = actions.computerName() ?? "your computer"
            do {
                let delivery = try await actions.newChat(text)
                let queued = delivery == .queued
                let speech = queued ? "Saved. The chat starts when \(computer) is back." : "Started a new chat on \(computer)."
                log("New chat on \(computer)", detail: queued ? "Waiting to send · \(computer) is offline" : "Started",
                    outcome: queued ? .waiting : .done, chatId: nil, spoken: speech)
                return say(speech)
            } catch {
                return failed("New chat on \(computer)", chatId: nil, error)
            }
        case .answer(let id, let callId, let allow):
            let c = chat(id)
            let step = c.map(stepName) ?? "the step"
            let name = c?.title ?? "the chat"
            // The chat moved on while the driver answered: do not answer a stale call.
            guard let c, c.callId == callId, c.state == .needsYou else {
                return say("\(name) isn't waiting on that any more, so nothing changed.")
            }
            if allow, !actions.unlocked() {
                return say("Allowing a tool needs your iPhone unlocked. It will keep waiting for you.")
            }
            do {
                try await actions.answer(id, callId, allow)
                let speech = "\(allow ? "Allowed" : "Denied") \(step)."
                log("\(allow ? "Allowed" : "Denied") \(step)", detail: c.title, outcome: .done, chatId: id, spoken: speech)
                return say(speech)
            } catch {
                return failed("\(allow ? "Allow" : "Deny") \(step)", chatId: id, error)
            }
        case .stop(let id):
            let name = chat(id)?.title ?? "the chat"
            do {
                try await actions.stop(id)
                log("Stopped \(name)", detail: "Its work so far is in the chat", outcome: .done, chatId: id, spoken: "Stopped \(name).")
                return say("Stopped \(name).")
            } catch {
                return failed("Stop \(name)", chatId: id, error)
            }
        }
    }

    private func failed(_ title: String, chatId: String?, _ error: Error) -> CarReply {
        let why = Self.reason(error)
        log(title, detail: why, outcome: .failed, chatId: chatId, spoken: "\(title) didn't work. \(why).")
        return say("That didn't work. \(why).")
    }

    /// One short, safe line: never a raw error that could carry a transcript or a path.
    static func reason(_ error: Error) -> String {
        if let e = error as? RelayError, e.message.count <= 80, !e.message.contains("/") {
            return e.message.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        }
        return "Couldn't reach the computer"
    }

    // MARK: Status

    private func status() -> CarReply {
        let all = chats()
        let speech = Self.statusSpeech(all)
        let needs = all.filter { $0.state == .needsYou }.count, working = all.filter { $0.state == .working }.count
        let detail = all.isEmpty ? "Nothing running" : [needs > 0 ? "\(needs) need\(needs == 1 ? "s" : "") you" : nil,
                                                         working > 0 ? "\(working) working" : nil].compactMap { $0 }.joined(separator: ", ")
        log("Status", detail: detail.isEmpty ? "All quiet" : detail, outcome: .info, chatId: nil, spoken: speech)
        return say(speech)
    }

    /// Counts, then what needs you by name, then what is working.
    public static func statusSpeech(_ all: [CarChat]) -> String {
        let needs = all.filter { $0.state == .needsYou }
        let working = all.filter { $0.state == .working }
        let watching = all.filter { $0.state == .watching }
        if needs.isEmpty, working.isEmpty {
            return watching.isEmpty ? "All quiet. Nothing is running." : "All quiet. \(count(watching.count, "chat")) watching pull requests."
        }
        var parts: [String] = []
        if !needs.isEmpty {
            let named = needs.prefix(3).map { c in c.callId != nil ? "\(c.title), to allow \(stepName(c))" : "\(c.title), with a question" }
            parts.append("\(count(needs.count, "chat")) need\(needs.count == 1 ? "s" : "") you: \(named.joined(separator: "; ")).")
        }
        if !working.isEmpty {
            let named = working.prefix(3).map(\.title).joined(separator: ", ")
            parts.append("\(count(working.count, "chat")) \(working.count == 1 ? "is" : "are") working: \(named).")
        }
        return parts.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    // MARK: Results

    @discardableResult
    private func log(_ title: String, detail: String, outcome: CarResult.Outcome, chatId: String?, spoken: String) -> CarResult {
        let r = CarResult(id: nextId, title: title, detail: detail, outcome: outcome, chatId: chatId, at: now(), spoken: spoken)
        nextId += 1
        results.insert(r, at: 0)
        if results.count > Self.maxResults { results.removeLast(results.count - Self.maxResults) }
        return r
    }

    private func update(_ r: CarResult) {
        if let i = results.firstIndex(where: { $0.id == r.id }) { results[i] = r }
    }

    /// The chats changed: a send whose chat has a new reply says "Reply ready", and one
    /// that was waiting says it went once its chat runs.
    public func refresh() {
        let byId = Dictionary(chats().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for i in results.indices {
            guard let before = results[i].replyBefore, let id = results[i].chatId, let c = byId[id], !results[i].replyReady else { continue }
            if results[i].outcome == .waiting, c.state == .working || c.reply != before {
                results[i].outcome = .done
                results[i].detail = "Delivered"
            }
            let reply = c.reply.trimmingCharacters(in: .whitespacesAndNewlines)
            if reply != before, !reply.isEmpty, c.state != .working {
                results[i].replyReady = true
                results[i].outcome = .done
                results[i].detail = "Reply ready · tap to hear"
                results[i].spoken = "\(c.title) said: \(reply)"
            }
        }
    }

    /// A tap on a Results row: what it says again.
    public func speech(for resultId: Int) -> String? {
        guard let r = results.first(where: { $0.id == resultId }) else { return nil }
        lastSpoken = r.spoken
        return r.spoken
    }

    // MARK: The voice loop

    /// Listens, acts and speaks until the exchange is over: one command, its read-back
    /// and answer, or a chat's conversation. Audio is injected; cancelling the task
    /// (the sheet's Cancel) ends it at the next step, and nothing is sent after that.
    public func talk(inChat: String? = nil,
                     capture: () async throws -> String,
                     speak: (String) async throws -> Void,
                     phase: (CarVoicePhase) -> Void,
                     awaitReply: (_ chatId: String, _ before: String) async throws -> String?) async {
        defer { phase(.done) }
        var turns = 0
        do {
            while turns < Self.maxTurns {
                turns += 1
                try Task.checkCancellation()
                phase(.listening)
                let words = try await capture().trimmingCharacters(in: .whitespacesAndNewlines)
                try Task.checkCancellation()
                guard !words.isEmpty else {
                    if pending != nil || choice != nil { reset() }
                    phase(.speaking)
                    try await speak(turns == 1 ? "I didn't hear anything." : "OK, nothing changed.")
                    return
                }
                phase(.working)
                let before = inChat.flatMap { chat($0)?.reply } ?? ""
                let reply = await handle(words, inChat: inChat)
                try Task.checkCancellation()
                phase(reply.confirming ? .confirming : .speaking)
                try await speak(reply.speech)
                switch reply.next {
                case .end: return
                case .listen: continue
                case .awaitReply(let id):
                    phase(.working)
                    guard let answer = try await awaitReply(id, before) else {
                        phase(.speaking)
                        try await speak("It's still working. I'll put its reply in Results.")
                        return
                    }
                    try Task.checkCancellation()
                    let text = MarkdownParser.plainText(answer).trimmingCharacters(in: .whitespacesAndNewlines)
                    phase(.speaking)
                    try await speak(remember(text.isEmpty ? "It finished without a reply." : text))
                    refresh()
                }
            }
        } catch {
            // Cancel or an audio failure: drop any open read-back so nothing runs later.
            reset()
        }
    }

    // MARK: Helpers

    private func chat(_ id: String) -> CarChat? { chats().first { $0.id == id } }

    private func say(_ speech: String) -> CarReply { CarReply(remember(speech)) }

    private func remember(_ speech: String) -> String {
        lastSpoken = speech
        return speech
    }

    private func notActionable(_ c: CarChat) -> String {
        "\(c.title) is on \(c.computerName). From the car I can act on chats on your active computer."
    }

    private func stateSentence(_ c: CarChat) -> String {
        switch c.state {
        case .needsYou: return "It needs you."
        case .working: return "It's working."
        case .watching: return "It's watching a pull request."
        case .done: return "It's finished."
        case .failed: return "It stopped with an error."
        }
    }
}

/// "Allow: run npm test" → "run npm test".
func stepName(_ c: CarChat) -> String {
    let s = c.step.trimmingCharacters(in: .whitespaces)
    for prefix in ["Allow: ", "Allow ", "Approve: "] where s.hasPrefix(prefix) { return String(s.dropFirst(prefix.count)) }
    return s.isEmpty ? "the waiting step" : s
}

private func count(_ n: Int, _ noun: String) -> String {
    let words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
    let number = n < words.count ? words[n] : String(n)
    return "\(number) \(noun)\(n == 1 ? "" : "s")"
}

private func ordinal(_ n: Int) -> String { ["first", "second", "third"][min(max(n, 1), 3) - 1] }

public extension LiveChatState {
    /// The state as one word for the car's rows.
    var word: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .watching: return "Watching"
        case .done: return "Done"
        case .failed: return "Stopped with an error"
        }
    }
}
