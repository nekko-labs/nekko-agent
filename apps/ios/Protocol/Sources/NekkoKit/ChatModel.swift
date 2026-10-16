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
        didSet { savedBlocks = session.map { Transcript.fromMessages($0.messages) } ?? [] }
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
    /// The computer's runnable skills, re-read with the chat.
    public private(set) var skills: [SkillSummary] = []
    public private(set) var sending = false

    private let store: ComputersStore
    private let now: () -> Int64
    private var subscription: UUID?
    private var reloadTask: Task<Void, Never>?
    private var lastConn: RelayState = .idle

    public init(sessionId: String, store: ComputersStore, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.sessionId = sessionId
        self.store = store
        self.now = now
    }

    /// Start following the computer's events for this chat.
    public func start() {
        guard subscription == nil else { return }
        subscription = store.subscribe { [weak self] e in self?.onEvent(e) }
        Task { await reload() }
    }

    public func stop() {
        if let subscription { store.unsubscribe(subscription) }
        subscription = nil
    }

    /// The connection came back: re-read, in case events were missed.
    public func connectionChanged(_ state: RelayState) {
        defer { lastConn = state }
        if state == .online && lastConn != .online && subscription != nil { Task { await reload() } }
    }

    public func reload() async {
        do {
            let r = try store.remote()
            async let raw = r.call(Channels.sessionGet, [.string(sessionId)])
            async let pendingRaw = orNil { try await r.call(Channels.chatPending) }
            let (s, p) = (try await raw, await pendingRaw)
            Task { await loadSkills() }
            guard let session = Session.from(s) else {
                loadError = "This chat was deleted on your computer."
                return
            }
            let mine = PendingInput.map(p)[sessionId]
            let shown = blocks
            self.session = session
            loadError = nil
            // Mid-turn the overlay keeps streaming; mergeLive hides what the
            // re-read session already holds. After the turn the session has it all.
            var t = turn
            if !t.running { t.blocks = [] }
            t.approval = mine?.approval
            t.question = mine?.question
            t.running = t.running || mine != nil
            turn = t
            // Keep the ids of what was on screen when the saved transcript replaces the live one.
            let carried = Transcript.carriedIds(shown: shown, next: Transcript.mergeLive(saved: savedBlocks, live: turn.blocks))
            if !carried.isEmpty { shownIds.merge(carried) { a, _ in a } }
        } catch {
            loadError = error.localizedDescription
        }
    }

    public func loadSkills() async {
        guard let r = try? store.remote(), let raw = try? await r.call(Channels.skillsRunnable) else { return }
        skills = SkillSummary.list(raw)
    }

    /// Fold one event; re-reads the saved transcript when the turn ends.
    public func onEvent(_ e: AgentEvent) {
        guard e.sessionId == sessionId else { return }
        turn = Transcript.apply(turn, e)
        switch e {
        case .done, .error, .sessionMeta: scheduleReload()
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

    /// Throws when the prompt couldn't be sent, so the composer can keep the text.
    /// `images` are `data:image/jpeg;base64,…` URLs.
    public func send(_ text: String, skill: SkillSummary? = nil, images: [String] = []) async throws {
        let r = try store.remote()
        if turn.running {
            // Same as the desktop: a prompt sent mid-run waits its turn.
            let s = Session.from(try await r.call(Channels.chatQueue, [.string(sessionId), queuePrompt(text: text, skill: skill, images: images)]))
            if let s { session = s }
            return
        }
        let (providerId, modelId) = Self.resolveModel(session, store.defaults)
        guard let providerId, let modelId else { throw RelayError("Choose a default model on your computer first.") }
        let at = now()
        let shown = skill.map { "/\($0.name) \(text)".trimmingCharacters(in: .whitespaces) } ?? text
        turn = LiveTurn(running: true, blocks: [.user(id: "pending-\(at)", text: shown, at: at, images: images.count)], startedAt: at)
        sending = true
        // Resolves only when the whole turn ends; the events carry the progress.
        Task { @MainActor in
            defer { self.sending = false }
            do {
                _ = try await r.call(Channels.chatSend, [sendOptions(sessionId: sessionId, providerId: providerId, modelId: modelId,
                                                                     text: text, skill: skill, images: images)], timeout: turnTimeout)
            } catch {
                var t = self.turn
                // Nothing came back for it: give the prompt back instead of
                // leaving a bubble that was never delivered.
                let started = t.blocks.contains { $0.id != "pending-\(at)" }
                if !started {
                    t.blocks.removeAll { $0.id == "pending-\(at)" }
                    self.unsent = UnsentPrompt(text: text, skill: skill, images: images)
                }
                t.running = false
                t.error = error.localizedDescription
                self.turn = t
            }
        }
    }

    public func abort() {
        guard let r = try? store.remote() else { return }
        let id = sessionId
        Task { _ = try? await r.call(Channels.chatAbort, [.string(id)]) }
    }

    public func approve(_ ok: Bool) async throws {
        guard let a = turn.approval else { return }
        turn.approval = nil
        do {
            _ = try await store.remote().call(Channels.toolApprove, [.string(sessionId), .string(a.call.id), .bool(ok)])
        } catch {
            // The computer is still waiting: keep the card so the user can try again.
            if turn.approval == nil { turn.approval = a }
            throw error
        }
    }

    public func answer(_ answers: [AskAnswer]) async throws {
        guard let q = turn.question else { return }
        turn.question = nil
        do {
            _ = try await store.remote().call(Channels.chatAnswer, [.string(sessionId), .string(q.callId), .array(answers.map(\.json))])
        } catch {
            if turn.question == nil { turn.question = q }
            throw error
        }
    }

    /// Put a prompt back in the composer (it couldn't be sent from elsewhere).
    public func handBack(_ prompt: UnsentPrompt) { unsent = prompt }

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
        _ = try await store.remote().call(Channels.sessionSetOptions, [.string(sessionId), .object(o)])
        await reload()
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

    /// Why the composer can't send right now, or nil.
    public var blocked: String? {
        let name = store.active?.name ?? "your computer"
        let (p, m) = Self.resolveModel(session, store.defaults)
        if store.conn == .denied || store.denied != nil { return "This phone is no longer paired." }
        if store.conn != .online { return "\(name) is \(store.conn == .offline ? "offline" : "reconnecting")." }
        if p == nil || m == nil { return "No model chosen for this chat. Set a default model on your computer." }
        return nil
    }
}
