import Foundation
import NekkoProtocol
import Observation

/// What the Monitors pane reads from and answers through: the active computer.
@MainActor
public protocol MonitorBackend: AnyObject {
    /// A plain call: `monitor:summary`, `chat:pending`, and the answers
    /// (`tool:approve`, `chat:answer`), exactly as a chat sends them.
    func read(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue
    /// Every `agent:event` from the computer. Returns an id for `unsubscribe`.
    func subscribe(_ f: @escaping (AgentEvent) -> Void) -> UUID
    func unsubscribe(_ id: UUID)
    /// The computer's name, for messages.
    var computerName: String { get }
    /// Connected now: approvals and answers are never sent later.
    var isOnline: Bool { get }
}

extension ComputersStore: MonitorBackend {
    public var isOnline: Bool { conn == .online }
}

/// The Monitors pane (FD-5): the computer's `monitor:summary`, re-read every
/// 10 s while the pane is on screen and soon after an event that changes what
/// it shows (an approval or question asked or answered, a turn ending). It
/// never polls in the background: `start()` when the pane appears, `stop()`
/// when it goes. Allow / Deny / Answer go through the same `tool:approve`
/// and `chat:answer` calls as the chat.
@MainActor
@Observable
public final class MonitorModel {
    /// Seconds between reads while on screen.
    public nonisolated static let interval: TimeInterval = 10

    public private(set) var summary: MonitorSummary?
    /// The computer turned Read off for this phone (`read-off`).
    public private(set) var readOff = false
    /// The computer is too old to answer `monitor:summary`.
    public private(set) var unsupported = false
    public private(set) var error: String?
    public private(set) var loading = false
    public private(set) var loadedOnce = false
    /// The full questions waiting, by chat, so they can be answered here (`chat:pending`).
    public private(set) var questions: [String: AskRequest] = [:]
    /// Rows answered from here, hidden until the next read drops them.
    public private(set) var handled: Set<String> = []
    /// The poll is running (the pane is on screen).
    public private(set) var watching = false

    private let backend: MonitorBackend
    private let interval: TimeInterval
    private var loop: Task<Void, Never>?
    private var soon: Task<Void, Never>?
    private var subscription: UUID?

    public init(backend: MonitorBackend, interval: TimeInterval = MonitorModel.interval) {
        self.backend = backend
        self.interval = interval
    }

    /// The pane is on screen: read now, then every `interval`, and after events.
    public func start() {
        guard loop == nil else { return }
        watching = true
        subscription = backend.subscribe { [weak self] e in self?.onEvent(e) }
        let wait = UInt64(max(1, interval) * 1_000_000_000)
        loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: wait)
            }
        }
    }

    /// The pane left the screen (or the app went to the background): no more reads.
    public func stop() {
        loop?.cancel()
        loop = nil
        soon?.cancel()
        soon = nil
        if let subscription { backend.unsubscribe(subscription) }
        subscription = nil
        watching = false
    }

    /// The events that change what Monitors shows bring the next read forward.
    func onEvent(_ e: AgentEvent) {
        switch e {
        case .approvalRequired, .question, .questionResolved, .done, .error, .sessionMeta:
            readSoon()
        default:
            break
        }
    }

    private func readSoon() {
        guard watching else { return }
        soon?.cancel()
        soon = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    /// One read. Offline it keeps what it has; a refusal says why.
    public func refresh() async {
        guard backend.isOnline else { return }
        loading = true
        defer {
            loading = false
            loadedOnce = true
        }
        do {
            let raw = try await backend.read(Channels.monitorSummary, [])
            guard let s = MonitorSummary.from(raw) else {
                error = "\(backend.computerName) didn’t answer with its monitors."
                return
            }
            summary = s
            handled = []
            readOff = false
            unsupported = false
            error = nil
            await readQuestions(s)
        } catch {
            noted(error)
        }
    }

    /// The questions' options, only when one is waiting (the summary carries the first line only).
    private func readQuestions(_ s: MonitorSummary) async {
        guard s.needsYou.contains(where: { $0.kind == .question }) else {
            questions = [:]
            return
        }
        guard let raw = try? await backend.read(Channels.chatPending, []) else { return }
        var out: [String: AskRequest] = [:]
        for (sid, p) in PendingInput.map(raw) { if let q = p.question { out[sid] = q } }
        questions = out
    }

    private func noted(_ error: Error) {
        guard let e = error as? RelayError else {
            self.error = error.localizedDescription
            return
        }
        if e.fromComputer, let r = PhoneRefusal(e.message) {
            switch r.code {
            case "read-off":
                readOff = true
                summary = nil
                questions = [:]
                self.error = nil
                return
            case "channel-denied":
                unsupported = true
                self.error = nil
                return
            default:
                self.error = r.message(computer: backend.computerName) ?? e.message
                return
            }
        }
        if e.fromComputer && e.message.hasPrefix("Unknown channel") {
            unsupported = true
            self.error = nil
            return
        }
        self.error = e.message
    }

    // MARK: Showing

    public var running: [MonitorSummary.Running] { summary?.running ?? [] }
    public var needsYou: [MonitorSummary.NeedsYou] { (summary?.needsYou ?? []).filter { !handled.contains($0.id) } }
    public var automations: [MonitorSummary.Automation] { summary?.automations ?? [] }

    /// The full question for a Needs you row, when the computer sent it.
    public func question(_ item: MonitorSummary.NeedsYou) -> AskRequest? {
        guard item.kind == .question, let q = questions[item.sessionId], q.callId == item.callId else { return nil }
        return q
    }

    // MARK: Answering

    /// Allow or Deny, as the chat's approval card does (`tool:approve`).
    public func approve(_ item: MonitorSummary.NeedsYou, allow: Bool) async throws {
        guard item.kind == .approval else { return }
        guard backend.isOnline else { throw RelayError(ChatModel.reconnectToAnswer) }
        do {
            _ = try await backend.read(Channels.toolApprove, [.string(item.sessionId), .string(item.callId), .bool(allow)])
        } catch {
            throw plain(error)
        }
        handled.insert(item.id)
        readSoon()
    }

    /// Answer a question, as the chat's question card does (`chat:answer`).
    public func answer(_ item: MonitorSummary.NeedsYou, _ answers: [AskAnswer]) async throws {
        guard item.kind == .question else { return }
        guard backend.isOnline else { throw RelayError(ChatModel.reconnectToAnswer) }
        do {
            _ = try await backend.read(Channels.chatAnswer, [.string(item.sessionId), .string(item.callId), .array(answers.map(\.json))])
        } catch {
            throw plain(error)
        }
        handled.insert(item.id)
        readSoon()
    }

    private func plain(_ error: Error) -> Error {
        guard let e = error as? RelayError, e.fromComputer, let r = PhoneRefusal(e.message),
              let m = r.message(computer: backend.computerName) else { return error }
        return RelayError(m, fromComputer: true)
    }

    // MARK: Words

    /// "4 min", "1 h 5 min", "12 s": how long a chat has been working.
    public nonisolated static func elapsed(_ ms: Int64) -> String {
        let s = max(0, ms / 1000)
        if s < 60 { return "\(s) s" }
        let m = s / 60
        if m < 60 { return "\(m) min" }
        let h = m / 60, rest = m % 60
        return rest == 0 ? "\(h) h" : "\(h) h \(rest) min"
    }

    /// Whole degrees Celsius.
    public nonisolated static func temperature(_ c: Double) -> String { "\(Int(c.rounded())) °C" }

    /// "20 of 64 GB" (or MB under a gigabyte).
    public nonisolated static func memory(usedMB: Double, totalMB: Double) -> String {
        func gb(_ mb: Double) -> String {
            let g = mb / 1024
            return g >= 10 ? "\(Int(g.rounded()))" : String(format: "%.1f", g)
        }
        if totalMB < 1024 { return "\(Int(usedMB.rounded())) of \(Int(totalMB.rounded())) MB" }
        return "\(gb(usedMB)) of \(gb(totalMB)) GB"
    }
}
