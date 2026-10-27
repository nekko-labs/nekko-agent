import Foundation
import NekkoProtocol
import Observation

/// A prompt that didn't reach the computer, with what was attached to it.
public struct UnsentPrompt: Equatable, Sendable {
    public let text: String
    public let skill: SkillSummary?
    public let images: [String]

    public init(text: String, skill: SkillSummary?, images: [String]) {
        self.text = text
        self.skill = skill
        self.images = images
    }
}

/// A turn can run for hours (long agent runs); don't time the request out.
public let turnTimeout: TimeInterval = 12 * 60 * 60

/// A chat that lives on the computer: Android's `ChatController` (itself the
/// logic of the Expo app's `useRemoteChat`). The saved session is the source
/// of truth; while a turn runs, `agent:event`s fold into a live overlay, and
/// the session is re-read when the turn ends (or after a reconnect, in case
/// events were missed while the phone was asleep).
@MainActor
@Observable
public final class ChatModel {
    public let sessionId: String
    public private(set) var session: Session? {
        // Parsed once per read, not on every streamed token.
        didSet {
            savedBlocks = session.map { Transcript.fromMessages($0.messages) } ?? []
            // What the computer lists has arrived: it leaves the outbox.
            if let ids = session?.clientMessageIds, !ids.isEmpty { store.outbox.confirm(sessionId, ids) }
        }
    }
    private var savedBlocks: [Block] = []
    /// Saved block id → the live id the view already shows it under (see `Transcript.carriedIds`).
    private var shownIds: [String: String] = [:]
    public private(set) var turn = LiveTurn() {
        didSet { if running != turn.running { running = turn.running } }
    }
    /// `turn.running`, changing only when it does: views that need just this
    /// (the composer's Send / Stop) don't redraw on every streamed token.
    public private(set) var running = false
    /// A prompt the computer never started on, handed back to the composer.
    public private(set) var unsent: UnsentPrompt?
    public private(set) var loadError: String?
    /// When the transcript on screen is the phone's saved copy (the computer
    /// hasn't answered since it opened), when that copy was saved; nil once
    /// the computer has sent the chat (OF-5, OF-6).
    public private(set) var savedAt: Int64?
    /// The computer's runnable skills, re-read with the chat.
    public private(set) var skills: [SkillSummary] = []
    public private(set) var sending = false
    /// The chat's durable watches (`session:watches`), for the watch rows' live chips.
    public private(set) var watches: [AgentWatch] = []
    /// This chat's subagent chats (the list hides them), for the delegation rows' status and model.
    public private(set) var children: [SessionSummary] = []

    private let store: ComputersStore
    private let now: () -> Int64
    private var subscription: UUID?
    private var reloadTask: Task<Void, Never>?
    /// This chat's events so far, so a re-read can tell whether any came in while it waited.
    private var eventsSeen = 0
    private var agentStateTask: Task<Void, Never>?
    private var lastConn: RelayState = .idle

    public init(sessionId: String, store: ComputersStore, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.sessionId = sessionId
        self.store = store
        self.now = now
    }

    /// Start following the computer's events for this chat. A saved copy, if
    /// the phone has one, is on screen at once; the computer's answer then
    /// replaces it in place (the same message ids, so nothing jumps).
    public func start() {
        guard subscription == nil else { return }
        subscription = store.subscribe { [weak self] e in self?.onEvent(e) }
        showSavedCopy()
        Task { await reload() }
        pollAgentState()
    }

    /// While a watch is armed, its chip is re-read every 15 s (the desktop's cadence).
    private func pollAgentState() {
        agentStateTask?.cancel()
        agentStateTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if self.watches.contains(where: { $0.status == .active }) { await self.refreshAgentState() }
            }
        }
    }

    /// Re-read what the agent-work rows show beyond the transcript: the watches,
    /// and the child chats when the transcript delegates. Failures keep the last state.
    public func refreshAgentState() async {
        guard let r = try? store.remote() else { return }
        let hasWatch = blocks.contains { if case .tool(_, let name, _, _, _, _) = $0 { return name == AgentRows.watchTool } else { return false } }
        let hasAgent = blocks.contains { if case .tool(_, let name, _, _, _, _) = $0 { return name == AgentRows.subagentTool } else { return false } }
        if hasWatch, let raw = try? await r.call(Channels.sessionWatches, [.string(sessionId)]) { watches = AgentWatch.list(raw) }
        if hasAgent, let raw = try? await r.call(Channels.sessionsSummaries) {
            let id = sessionId
            children = SessionSummary.list(raw).filter { $0.parentSessionId == id }
        }
    }

    /// Paint the saved copy while nothing better is on screen.
    private func showSavedCopy() {
        guard session == nil, let saved = store.transcripts.saved(sessionId) else { return }
        session = saved.session
        savedAt = saved.savedAt
        store.transcripts.touch(sessionId)
    }

    public func stop() {
        if let subscription { store.unsubscribe(subscription) }
        subscription = nil
        agentStateTask?.cancel()
        agentStateTask = nil
    }

    /// The connection came back: re-read, in case events were missed.
    public func connectionChanged(_ state: RelayState) {
        defer { lastConn = state }
        if state == .online && lastConn != .online && subscription != nil { Task { await reload() } }
    }

    public func reload() async {
        let eventsBefore = eventsSeen
        do {
            let r = try store.remote()
            async let raw = r.call(Channels.sessionGet, [.string(sessionId)])
            async let pendingRaw = orNil { try await r.call(Channels.chatPending) }
            let (s, p) = (try await raw, await pendingRaw)
            Task { await loadSkills() }
            guard let session = Session.from(s) else {
                loadError = "This chat was deleted on your computer."
                store.transcripts.remove(sessionId)
                if savedAt != nil {
                    savedAt = nil
                    self.session = nil
                }
                return
            }
            let mine = PendingInput.map(p)[sessionId]
            let shown = blocks
            self.session = session
            savedAt = nil
            loadError = nil
            store.transcripts.save(session)
            // Mid-turn the overlay keeps streaming; mergeLive hides what the
            // re-read session already holds. After the turn the session has it all.
            var t = turn
            if !t.running { t.blocks = [] }
            // The computer's pending inputs are the authority, unless events came in
            // while the re-read was in flight: then they are newer than its answer, and
            // a stale "nothing pending" took the approval or question card down while
            // the computer still waited on it (#1019).
            if eventsSeen == eventsBefore {
                t.approval = mine?.approval
                t.question = mine?.question
            }
            t.running = t.running || mine != nil
            turn = t
            // Keep the ids of what was on screen when the saved transcript replaces the live one.
            let carried = Transcript.carriedIds(shown: shown, next: Transcript.mergeLive(saved: savedBlocks, live: turn.blocks))
            if !carried.isEmpty { shownIds.merge(carried) { a, _ in a } }
            await refreshAgentState()
        } catch {
            // Out of reach: the saved copy (if any) says so itself, under "Saved copy from …".
            showSavedCopy()
            if savedAt != nil, !((error as? RelayError)?.fromComputer ?? false) { return }
            loadError = store.readable(error).localizedDescription
        }
    }

    /// What the agent changed in this chat; the computer refuses unless it allows phones to see changes.
    public func changes() async throws -> PhoneChanges {
        PhoneChanges.from(try await store.remote().call(Channels.changesList, [.string(sessionId)]))
    }

    public func loadSkills() async {
        guard let r = try? store.remote(), let raw = try? await r.call(Channels.skillsRunnable) else { return }
        skills = SkillSummary.list(raw)
    }

    /// Fold one event; re-reads the saved transcript when the turn ends.
    public func onEvent(_ e: AgentEvent) {
        guard e.sessionId == sessionId else { return }
        eventsSeen += 1
        turn = Transcript.apply(turn, e)
        switch e {
        case .done, .error, .sessionMeta: scheduleReload()
        // A watch is armed or cancelled at a tool result; a delegation's child appears then too.
        case .toolResult: Task { await refreshAgentState() }
        default: break
        }
    }

    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }

    /// Send a prompt. From this moment until the computer's copy of the chat
    /// lists its `clientMessageId`, it is on the phone's disk (the outbox), so
    /// a crash, iOS ending the app or a dropped connection never loses it.
    /// Offline it waits there and goes when the computer is back; online this
    /// chat sends it at once. Throws when the computer refused it, so the
    /// composer can keep the text. `images` are `data:image/jpeg;base64,…`
    /// URLs. Returns the prompt's `clientMessageId`.
    @discardableResult
    public func send(_ text: String, skill: SkillSummary? = nil, images: [String] = []) async throws -> String {
        let outbox = store.outbox
        let id = outbox.newId()
        guard store.conn == .online, let r = try? store.remote() else {
            outbox.add(chatId: sessionId, text: text, skill: skill, images: images, id: id)
            return id
        }
        // Anything already waiting for this chat goes first, in order.
        if !outbox.items(for: sessionId).isEmpty {
            outbox.add(chatId: sessionId, text: text, skill: skill, images: images, id: id)
            store.flushOutbox()
            return id
        }
        outbox.add(chatId: sessionId, text: text, skill: skill, images: images, id: id, direct: true)
        if turn.running {
            // Same as the desktop: a prompt sent mid-run waits its turn.
            do {
                let raw = try await callWithId(r, Channels.chatQueue, id) { cid in
                    [.string(self.sessionId), queuePrompt(text: text, skill: skill, images: images, clientMessageId: cid)]
                }
                if let s = Session.from(raw) { session = s }
                // Listed (confirmed by the didSet), or a computer too old to list it: done either way.
                outbox.drop(id)
            } catch let e as RelayError where e.fromComputer {
                outbox.drop(id)
                throw store.readable(e)
            } catch {
                // No answer: the outbox finds out, with the same id, when the computer is back.
                outbox.endDirect(id)
            }
            return id
        }
        let (providerId, modelId) = Self.resolveModel(session, store.defaults)
        guard let providerId, let modelId else {
            outbox.drop(id)
            throw RelayError("Choose a default model on your computer first.")
        }
        let at = now()
        let shown = skill.map { "/\($0.name) \(text)".trimmingCharacters(in: .whitespaces) } ?? text
        turn = LiveTurn(running: true, blocks: [.user(id: "pending-\(at)", text: shown, at: at, images: images.count)], startedAt: at)
        sending = true
        // Resolves only when the whole turn ends; the events carry the progress.
        Task { @MainActor in
            defer { self.sending = false }
            do {
                _ = try await self.callWithId(r, Channels.chatSend, id, timeout: turnTimeout) { cid in
                    [sendOptions(sessionId: self.sessionId, providerId: providerId, modelId: modelId, text: text, skill: skill,
                                 images: images, clientMessageId: cid)]
                }
                // The turn ended. The re-read confirms the prompt; if the chat
                // doesn't list it, the outbox settles it (a refusal comes back as a draft).
                await self.reload()
                if outbox.direct.contains(id) {
                    outbox.endDirect(id)
                    self.store.flushOutbox()
                }
            } catch {
                var t = self.turn
                let started = t.blocks.contains { $0.id != "pending-\(at)" }
                if !started { t.blocks.removeAll { $0.id == "pending-\(at)" } }
                t.running = false
                if let e = error as? RelayError, e.fromComputer {
                    // The computer turned it down: the prompt goes back to the composer.
                    outbox.drop(id)
                    if !started { self.unsent = UnsentPrompt(text: text, skill: skill, images: images) }
                    t.error = self.store.readable(e).localizedDescription
                } else {
                    // No answer (the connection dropped): it may or may not have
                    // arrived. The outbox sends it again with the same id once the
                    // computer is back, and the computer takes it only once.
                    outbox.endDirect(id)
                }
                self.turn = t
            }
        }
        return id
    }

    /// `channel` with the prompt's `clientMessageId`. A computer from before
    /// exactly-once delivery refuses the unknown key: then the prompt goes
    /// as before, without it, and the outbox lets go of it (it could not tell
    /// whether a resend would run twice).
    private func callWithId(_ r: RemoteConnection, _ channel: String, _ id: String, timeout: TimeInterval? = nil,
                            _ args: (String?) -> [JSONValue]) async throws -> JSONValue {
        do {
            return try await r.call(channel, args(id), timeout: timeout)
        } catch let e as RelayError where e.fromComputer && Outbox.isOldComputer(e) {
            store.outbox.drop(id)
            return try await r.call(channel, args(nil), timeout: timeout)
        }
    }

    /// The computer's copy of this chat lists the prompt: it was delivered.
    public func delivered(_ clientMessageId: String) -> Bool {
        session?.clientMessageIds.contains(clientMessageId) == true
    }

    public func abort() {
        guard let r = try? store.remote() else { return }
        let id = sessionId
        Task { _ = try? await r.call(Channels.chatAbort, [.string(id)]) }
    }

    /// Approvals and answers are never queued: they are time-sensitive and safety-relevant.
    public static let reconnectToAnswer = "Reconnect to answer. Approvals and answers are never sent later."

    public func approve(_ ok: Bool) async throws {
        guard let a = turn.approval else { return }
        guard store.conn == .online else { throw RelayError(Self.reconnectToAnswer) }
        turn.approval = nil
        do {
            _ = try await store.remote().call(Channels.toolApprove, [.string(sessionId), .string(a.call.id), .bool(ok)])
        } catch {
            // The computer is still waiting: keep the card so the user can try again.
            if turn.approval == nil { turn.approval = a }
            throw store.readable(error)
        }
    }

    public func answer(_ answers: [AskAnswer]) async throws {
        guard let q = turn.question else { return }
        guard store.conn == .online else { throw RelayError(Self.reconnectToAnswer) }
        turn.question = nil
        do {
            _ = try await store.remote().call(Channels.chatAnswer, [.string(sessionId), .string(q.callId), .array(answers.map(\.json))])
        } catch {
            if turn.question == nil { turn.question = q }
            throw store.readable(error)
        }
    }

    /// Put a prompt back in the composer (it couldn't be sent from elsewhere).
    public func handBack(_ prompt: UnsentPrompt) { unsent = prompt }

    /// Text to add to the message box (a quoted line from Changes), taken once by the composer.
    public private(set) var insert: String?
    public func quote(_ text: String) { insert = text }
    public func takeInsert() -> String? {
        defer { insert = nil }
        return insert
    }

    /// Photos dropped on the chat (from the other pane, or another app), as
    /// JPEG data URLs: taken once by the composer, never sent by the drop.
    public private(set) var insertImages: [String] = []
    public func attach(images: [String]) { insertImages += images }
    public func takeImages() -> [String] {
        defer { insertImages = [] }
        return insertImages
    }

    /// The prompt to put back in the composer after a failed send, once.
    public func takeUnsent() -> UnsentPrompt? {
        defer { unsent = nil }
        return unsent
    }

    /// Change this chat's model or tool policy on the computer.
    public func setOptions(providerId: String? = nil, modelId: String? = nil, mode: PcSettings.ChatMode? = nil) async throws {
        var o: [String: JSONValue] = [:]
        if let providerId { o["providerId"] = .string(providerId) }
        if let modelId { o["modelId"] = .string(modelId) }
        if let mode { o["mode"] = .string(mode.rawValue) }
        guard !o.isEmpty else { return }
        // Raising the mode (fewer approvals) needs Face ID; the computer says when.
        _ = try await store.call(raising: Channels.sessionSetOptions, [.string(sessionId), .object(o)])
        await reload()
    }

    // MARK: The queue, forks and pull requests

    /// Editing the computer's queue needs the computer: an edit made offline could land after the prompt ran.
    public static let reconnectToEditQueue = "Reconnect to change the queue. The computer may start the prompt meanwhile."

    /// The queue as the computer holds it, oldest first.
    public var queuedPrompts: [QueuedPrompt] { session?.queued ?? [] }

    /// Change the queued prompt at `index` before it runs, or remove it (`text` nil). The computer
    /// refuses when that prompt no longer reads `expect` (it started, or the queue moved).
    public func editQueued(_ index: Int, expect: String, text: String?) async throws {
        guard store.conn == .online else { throw RelayError(Self.reconnectToEditQueue) }
        let edit = QueuedPrompt.edit(expect: expect, text: text)
        do {
            _ = try await store.remote().call(Channels.chatEditQueued, [.string(sessionId), .int(Int64(index)), edit])
        } catch {
            // Show the queue as it is now, whatever happened to this edit.
            await reload()
            throw store.readable(error)
        }
        await reload()
    }

    /// Where a fork from `block` cuts the chat, and what goes back in the new chat's message box.
    /// A prompt: the new chat ends before it, with that prompt to edit and send (the desktop's split).
    /// A reply or step: the new chat keeps everything up to the next prompt. Nil while it streams.
    public func forkPoint(_ block: Block) -> (before: String?, seed: String?)? {
        // A block shown under its live id (sent from here) is the saved message it was carried to.
        let id = shownIds.first { $0.value == block.id }?.key ?? block.id
        guard let messages = session?.messages,
              let at = messages.firstIndex(where: { $0.id == id || $0.toolCalls.contains { $0.id == id } }) else { return nil }
        let m = messages[at]
        if case .user = block, m.role == "user" {
            return (m.id, m.skill.map { "/\($0.name) \($0.input)".trimmingCharacters(in: .whitespaces) } ?? m.content)
        }
        let next = messages[(at + 1)...].first { $0.role == "user" }
        return (next?.id, nil)
    }

    /// Fork this chat on the computer from `block` (see `forkPoint`). Returns the new chat's id,
    /// with the forked prompt already in its message box.
    public func fork(from block: Block) async throws -> String {
        guard let point = forkPoint(block) else { throw RelayError("Wait for this reply to finish, then fork.") }
        var args: [JSONValue] = [.string(sessionId)]
        if let before = point.before { args.append(.string(before)) }
        let made = try await store.remote().call(Channels.sessionFork, args)
        guard let id = made.str("id") else { throw RelayError("Your computer didn’t fork the chat.") }
        if let seed = point.seed, !seed.isEmpty { store.drafts.set(id, Draft(text: seed)) }
        store.reloadList()
        return id
    }

    /// The pull requests this chat opened, with their state and checks (read only).
    public func pullRequests(refresh: Bool = false) async throws -> [PullRequest] {
        PullRequest.list(try await store.remote().call(Channels.prSessionList, [.string(sessionId), .bool(refresh)]))
    }

    /// A message's photos as the computer sent them (small JPEG data URLs; `""` for one it kept back).
    public func photos(_ messageId: String) -> [String] {
        session?.messages.first { $0.id == messageId }?.images ?? []
    }

    // MARK: Projection

    /// The session's own model, else the computer's default (never the `__auto__` sentinel).
    public nonisolated static func resolveModel(_ session: Session?, _ defaults: RemoteDefaults) -> (String?, String?) {
        let providerId = session?.providerId ?? defaults.defaultProviderId
        let modelId = session?.modelId.flatMap { $0 == autoModelId ? nil : $0 } ?? defaults.defaultModelId
        return (providerId, modelId)
    }

    public var title: String {
        let t = session?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Chat" : t
    }

    public var modelId: String? { Self.resolveModel(session, store.defaults).1 }

    public var blocks: [Block] {
        let merged = Transcript.mergeLive(saved: savedBlocks, live: turn.blocks)
        guard !shownIds.isEmpty else { return merged }
        return merged.map { b in shownIds[b.id].map { b.withId($0) } ?? b }
    }

    public var queued: [String] { session?.queue ?? [] }
    public var error: String? { loadError ?? turn.error }
    public var ready: Bool { session != nil || loadError != nil }

    /// Why the composer can't send right now, or nil. Being offline is not a
    /// reason: the prompt waits in the outbox (`sendsLater`).
    public var blocked: String? {
        let (p, m) = Self.resolveModel(session, store.defaults)
        if store.conn == .denied || store.denied != nil { return "This phone is no longer paired." }
        if store.conn == .online && session != nil && (p == nil || m == nil) {
            return "No model chosen for this chat. Set a default model on your computer."
        }
        return nil
    }

    /// The computer is out of reach: Send puts the prompt in the outbox ("Send when online").
    public var sendsLater: Bool { store.conn != .online }

    /// What the composer says about the connection while it is down, or nil.
    public var offlineNote: String? {
        guard store.conn != .online, store.conn != .denied, store.denied == nil else { return nil }
        let name = store.active?.name ?? "your computer"
        let state = store.conn == .offline ? "offline" : "reconnecting"
        return "\(name) is \(state). What you send waits on this iPhone and goes when it’s back."
    }

    /// This chat's prompts waiting in the outbox, oldest first.
    public var waiting: [OutboxItem] { store.outbox.items(for: sessionId) }
}
