import NekkoKit
import NekkoProtocol
import SwiftUI

/// What a Composer does with each dictated segment (IO-28): words go into the message, and
/// only an explicit "Nekko, ..." runs a command on this chat. The iOS twin of the desktop's
/// runVoiceIntent and voiceComposer (apps/desktop/src/renderer/voiceActions.ts); `Dictation`
/// does the listening. Segments are applied one at a time, in spoken order.
@MainActor
@Observable
final class VoiceRunner {
    struct ShipFacts {
        var prs: [PullRequest]
        var running: Bool
        var question: AskRequest?
    }

    /// The composer and the app, as closures so tests drive the runner without UI.
    struct Host {
        var text: Binding<String> = .constant("")
        /// Sends what is in the message box; false when it was refused (the text is back in the box).
        var send: () async -> Bool = { false }
        /// Every confirmation and error, as it is shown (VoiceOver reads it).
        var toast: (String) -> Void = { _ in }
        var tap: () -> Void = {}
        var chats: () -> [SessionSummary] = { [] }
        var open: (String) -> Void = { _ in }
        var newChat: () -> Void = {}
        var openSettings: () -> Void = {}
        var status: () -> String = { "" }
        var ship: () async throws -> ShipFacts = { ShipFacts(prs: [], running: false, question: nil) }
        /// nil once merged, else why not.
        var merge: (PullRequest) async -> String? = { _ in nil }
        var answer: (AskRequest, String) async throws -> Void = { _, _ in }
        var complete: () async throws -> Void = {}
        var title: () -> String = { "this chat" }
    }

    /// A command waiting on "Nekko, yes" or a tap on Confirm, or a list waiting on "Nekko, the first one" or a tap.
    struct Pending {
        let id = UUID()
        let message: String
        let confirm: Bool
        let options: [Option]
    }

    struct Option {
        let label: String
        let run: () async throws -> Void
    }

    struct Notice: Equatable {
        let id = UUID()
        let text: String
    }

    static let pendingSeconds: Double = 60
    static let wakeCarrySeconds: Double = 5
    static let computerOnly = "That one works on the computer"
    private static let sayYes = "Say 'Nekko, yes' or tap Confirm."
    private static let goAhead = "Go ahead and build it."

    var host = Host()
    /// Set once the composer is gone: what is still queued is kept as plain text (that chat's
    /// saved draft) and no command runs, since the composer and its chat are no longer on screen.
    var park: ((String) -> Void)?
    private(set) var pending: Pending?
    private(set) var notice: Notice?
    /// The last piece typed by voice, so "erase that" removes exactly it.
    private var last = ""
    private var carried: (wake: String, at: Date)?
    private var chain: Task<Void, Never>?

    /// Applies each segment's words after every earlier one.
    func hear(_ words: [Dictation.Words]) async {
        await enqueue { for w in words { await self.apply(w.text) } }
    }

    /// A tap on Confirm, Cancel or a listed option.
    func answer(_ intent: VoiceIntent) async { await enqueue { await self.act(intent) } }

    func started() { carried = nil }

    /// Listening stopped: a confirm left up must not be answered by a later "Nekko, yes".
    func stopped() { setPending(nil) }

    func clearNotice(_ id: UUID) { if notice?.id == id { notice = nil } }

    private func enqueue(_ work: @escaping () async -> Void) async {
        let previous = chain
        let task = Task {
            await previous?.value
            await work()
        }
        chain = task
        await task.value
    }

    private func apply(_ text: String) async {
        if let park { return park(text) }
        let carry = carried.flatMap { Date().timeIntervalSince($0.at) <= Self.wakeCarrySeconds ? $0.wake + " " : nil } ?? ""
        // A wake word left alone at the end waits for the next segment; carried too late it is dropped (it holds no words).
        let tail = splitWakeTail(carry + text)
        carried = tail.wake.isEmpty ? nil : (tail.wake, Date())
        for intent in splitVoiceSegments(tail.rest) {
            // A command earlier in this segment left the chat: its words still count, its commands don't run.
            if let park {
                switch intent { case .dictation(let t), .unknown(let t), .openChat(_, let t): park(t); default: break }
            } else {
                await act(intent)
            }
        }
    }

    private func act(_ intent: VoiceIntent) async {
        do {
            setPending(try await run(intent, pending))
        } catch {
            show(error.localizedDescription)
            // A confirm whose action failed is answered; leaving it up invites a second try by accident.
            switch intent { case .yes, .pick: setPending(nil); default: break }
        }
    }

    private func setPending(_ next: Pending?) {
        // An unchanged pending keeps its clock: talking on must not keep a confirm alive.
        guard next?.id != pending?.id else { return }
        pending = next
        guard let next else { return }
        host.tap()
        host.toast(next.message)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.pendingSeconds))
            if self?.pending?.id == next.id { self?.pending = nil }
        }
    }

    private func show(_ text: String) {
        notice = Notice(text: text)
        host.toast(text)
    }

    /// A command ran: say so, with a light tap.
    private func done(_ text: String) {
        show(text)
        host.tap()
    }

    private func run(_ intent: VoiceIntent, _ pending: Pending?) async throws -> Pending? {
        switch intent {
        case .dictation(let text), .unknown(let text):
            type(text)
        case .newSession:
            host.newChat()
            done("New chat")
        case .navigate(let view):
            if view == "settings" {
                host.openSettings()
                done("Opened Settings")
            } else {
                done(Self.computerOnly)
            }
        case .go:
            done(Self.computerOnly)
        case .openChat(let query, let text):
            let q = query.lowercased()
            let hits = host.chats().filter { !$0.archived && ($0.title.lowercased().contains(q) || ($0.firstUserText ?? "").lowercased().contains(q)) }.prefix(3)
            // A "Nekko, open ..." that names no chat is words, never dropped.
            if hits.isEmpty { type(text) }
            else if hits.count == 1, let chat = hits.first { open(chat) }
            else {
                return Pending(message: "Which chat? Say 'Nekko, the first one' or tap it.", confirm: false,
                               options: hits.map { chat in Option(label: Self.title(chat)) { [weak self] in self?.open(chat) } })
            }
        case .yes:
            guard let pending, pending.confirm, let run = pending.options.first?.run else { return pending }
            try await run()
            return nil
        case .no:
            if pending != nil { done("Cancelled") }
            return nil
        case .pick(let n):
            guard let pending, !pending.confirm, pending.options.indices.contains(n - 1) else { return pending }
            try await pending.options[n - 1].run()
            return nil
        case .erase:
            let current = host.text.wrappedValue
            let removed = !last.isEmpty && current.hasSuffix(last)
            if removed { host.text.wrappedValue = String(current.dropLast(last.count)) }
            last = ""
            if removed { done("Erased") }
        case .clear:
            last = ""
            host.text.wrappedValue = ""
            done("Cleared")
        case .send:
            if await send() { done("Sent") }
        case .status:
            done(host.status())
        case .completeSession:
            let title = host.title()
            return Pending(message: "Complete \"\(title)\"? \(Self.sayYes)", confirm: true, options: [Option(label: "Confirm") { [weak self] in
                try await self?.host.complete()
                self?.done("Completed \(title)")
            }])
        case .ship:
            return try await ship(pending)
        }
        return pending
    }

    private func ship(_ pending: Pending?) async throws -> Pending? {
        let facts = try await host.ship()
        let goAhead: () async throws -> Void = { [weak self] in
            guard let self else { return }
            // A turn waiting on a question is answered with the words: a send would queue behind that same turn.
            if let question = facts.question {
                try await host.answer(question, Self.goAhead)
                done("Sent")
                return
            }
            type(Self.goAhead, sentence: true)
            if await send() { done("Sent") }
        }
        switch Self.shipAction(facts) {
        case .goAhead: try await goAhead()
        case .stillWorking: done("It's still working")
        case .nothing: done("Nothing to ship")
        case .merge(let pr):
            return Pending(message: "Merge \(Self.label(pr))? \(Self.sayYes)", confirm: true, options: [Option(label: "Confirm") { [weak self] in await self?.merge(pr) }])
        case .ask(let pr):
            return Pending(message: "\(host.title()) has a question waiting for you. Say 'Nekko, the first one' or 'the second one', or tap one.", confirm: false,
                           options: [Option(label: "Merge \(Self.label(pr))") { [weak self] in await self?.merge(pr) }, Option(label: "Go ahead", run: goAhead)])
        }
        return pending
    }

    enum ShipAction: Equatable { case merge(PullRequest), ask(PullRequest), goAhead, stillWorking, nothing }

    /// What "Nekko, ship it" does for this chat (the desktop's shipAction).
    static func shipAction(_ f: ShipFacts) -> ShipAction {
        if let open = f.prs.first(where: { $0.state == .open }) { return f.question != nil ? .ask(open) : .merge(open) }
        if f.question != nil { return .goAhead }
        if f.running { return .stillWorking }
        // A chat whose PRs are all merged or closed already shipped.
        return f.prs.isEmpty ? .goAhead : .nothing
    }

    private func merge(_ pr: PullRequest) async {
        show("Merging \(Self.label(pr))")
        if let why = await host.merge(pr) { show(why) } else { done("Merged \(Self.label(pr))") }
    }

    private func open(_ chat: SessionSummary) {
        host.open(chat.id)
        done("Opened \(Self.title(chat))")
    }

    /// `sentence` starts the words as their own sentence after what is there.
    private func type(_ text: String, sentence: Bool = false) {
        var current = host.text.wrappedValue
        if sentence { while current.last?.isWhitespace == true { current.removeLast() } }
        let stop = sentence && !current.isEmpty && !(current.last.map { ".!?".contains($0) } ?? false) ? "." : ""
        let space = !current.isEmpty && current.last?.isWhitespace != true ? " " : ""
        last = stop + space + text
        host.text.wrappedValue = current + last
    }

    private func send() async -> Bool {
        guard !host.text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        last = ""
        return await host.send()
    }

    private static func title(_ chat: SessionSummary) -> String { chat.title.isEmpty ? "Untitled chat" : chat.title }

    /// `owner/repo#12` from the PR's GitHub address.
    static func label(_ pr: PullRequest) -> String {
        let parts = URL(string: pr.url)?.pathComponents ?? []
        return parts.count >= 3 ? "\(parts[1])/\(parts[2])#\(pr.number)" : "#\(pr.number)"
    }
}
