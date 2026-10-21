import Foundation
import NekkoProtocol
import Observation

/// What the terminal screens need from the connected computer (IO-33 FA-3,
/// FA-6). `ComputersStore` is one; the tests use a stand-in.
@MainActor
public protocol TerminalBackend: AnyObject {
    /// A plain call (read-class channels, typing with a token, leaving).
    func read(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue
    /// A Change action, signed (Face ID or the passcode within 5 minutes).
    func change(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue
    /// Every `terminal:event` from the computer (only terminals this phone opened).
    func subscribeTerminal(_ f: @escaping (TerminalEvent) -> Void) -> UUID
    func unsubscribeTerminal(_ id: UUID)
    /// The computer's name, for messages.
    var computerName: String { get }
}

/// A chat's terminals and the computer's SSH hosts (chat → More → Terminals).
@MainActor
@Observable
public final class TerminalsModel {
    public let sessionId: String
    public private(set) var terminals: [PhoneTerminal] = []
    public private(set) var hosts: [SshHost] = []
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var error: String?
    /// Why the hosts couldn't be read (no `~/.ssh/config`, Read turned off).
    public private(set) var hostsError: String?

    private let backend: TerminalBackend

    public init(sessionId: String, backend: TerminalBackend) {
        self.sessionId = sessionId
        self.backend = backend
    }

    public func load() async {
        loading = true
        defer { loading = false }
        let (channel, args) = TerminalRequest.list(sessionId: sessionId)
        do {
            terminals = PhoneTerminal.list(try await backend.read(channel, args))
            error = nil
        } catch {
            self.error = TerminalSession.describe(error, computer: backend.computerName)
        }
        let (h, hArgs) = TerminalRequest.hosts()
        do {
            hosts = SshHost.list(try await backend.read(h, hArgs))
            hostsError = nil
        } catch {
            hosts = []
            hostsError = TerminalSession.describe(error, computer: backend.computerName)
        }
        loaded = true
    }

    /// A new terminal in the chat's folder, opened on this phone.
    public func newTerminal(cols: Int, rows: Int) async throws -> TerminalSession {
        let (channel, args) = TerminalRequest.create(sessionId: sessionId, cols: cols, rows: rows)
        return try await opened(channel, args)
    }

    /// An SSH session to one of the computer's hosts, opened on this phone.
    public func openSsh(_ host: SshHost, cols: Int, rows: Int) async throws -> TerminalSession {
        let (channel, args) = TerminalRequest.sshOpen(alias: host.alias, sessionId: sessionId, cols: cols, rows: rows)
        return try await opened(channel, args)
    }

    /// A terminal from the list, not opened yet (`TerminalSession.start`).
    public func session(for terminal: PhoneTerminal) -> TerminalSession {
        TerminalSession(terminal: terminal, backend: backend)
    }

    private func opened(_ channel: String, _ args: [JSONValue]) async throws -> TerminalSession {
        let reply = try await backend.change(channel, args)
        guard let opened = TerminalOpened.from(reply), let terminal = opened.tail.terminal else {
            throw RelayError("\(backend.computerName) didn’t open the terminal. Update Nekko on \(backend.computerName).")
        }
        let s = TerminalSession(terminal: terminal, backend: backend)
        s.apply(opened)
        Task { await self.load() }
        return s
    }
}

/// One terminal open on the phone: its screen, typing with the token, resize,
/// leave and close. Output arrives as `terminal:event` for this terminal only.
@MainActor
@Observable
public final class TerminalSession: Identifiable {
    public enum State: Equatable, Sendable {
        case opening
        /// Attached: output streams, typing works.
        case live
        /// The agent's command log, or a terminal shown without attaching: refresh to read more.
        case readOnly
        case exited(Int?)
        case closed
        case failed(String)
    }

    public nonisolated var id: String { terminalId }
    public nonisolated let terminalId: String
    public private(set) var terminal: PhoneTerminal
    public private(set) var state: State = .opening
    /// Bumped whenever the screen changed, for the view to redraw.
    public private(set) var version = 0
    /// The last error of a write or resize, to show briefly.
    public private(set) var error: String?
    public let screen: TerminalScreen

    private let backend: TerminalBackend
    private var token: String?
    private var subscription: UUID?
    /// The terminal's size when this phone opened it, restored on leaving.
    private var originalSize: (cols: Int, rows: Int)?
    private var queue: [Op] = []
    private var draining = false
    private var lastResync: Date = .distantPast

    private enum Op: Equatable {
        case write(String)
        case resize(Int, Int)
    }

    public init(terminal: PhoneTerminal, backend: TerminalBackend) {
        self.terminalId = terminal.id
        self.terminal = terminal
        self.backend = backend
        screen = TerminalScreen()
    }

    /// Whether typing is possible now.
    public var canType: Bool { state == .live && token != nil }

    /// Attach (a Change action: Face ID within 5 minutes) and replay the tail,
    /// or for the agent's command log just read it.
    public func start() async {
        listen()
        if terminal.readOnly {
            await refresh()
            return
        }
        state = .opening
        do {
            try await reopen()
        } catch {
            state = .failed(Self.describe(error, computer: backend.computerName))
        }
    }

    /// Read the tail again (the agent's log; or after the computer dropped output).
    public func refresh() async {
        let (channel, args) = TerminalRequest.tail(terminalId)
        do {
            guard let tail = TerminalTail.from(try await backend.read(channel, args)) else { return }
            replay(tail)
            if terminal.readOnly { state = .readOnly }
        } catch {
            if terminal.readOnly { state = .failed(Self.describe(error, computer: backend.computerName)) } else { self.error = Self.describe(error, computer: backend.computerName) }
        }
    }

    /// The reply of `terminal:open` / `terminal:create` / `ssh:open`.
    public func apply(_ opened: TerminalOpened) {
        listen()
        token = opened.token
        if originalSize == nil { originalSize = (opened.tail.cols, opened.tail.rows) }
        replay(opened.tail)
        state = opened.tail.terminal?.running == false ? .exited(opened.tail.terminal?.exitCode) : .live
    }

    private func replay(_ tail: TerminalTail) {
        if let t = tail.terminal { terminal = t }
        screen.reset()
        screen.resize(cols: tail.cols, rows: tail.rows)
        screen.feed(tail.buffer)
        version += 1
    }

    private func reopen() async throws {
        let (channel, args) = TerminalRequest.open(terminalId)
        let reply = try await backend.change(channel, args)
        guard let opened = TerminalOpened.from(reply) else {
            throw RelayError("\(backend.computerName) didn’t open the terminal. Update Nekko on \(backend.computerName).")
        }
        apply(opened)
    }

    private func listen() {
        guard subscription == nil else { return }
        subscription = backend.subscribeTerminal { [weak self] e in self?.handle(e) }
    }

    /// One `terminal:event` (the store hands every one to every open session).
    public func handle(_ event: TerminalEvent) {
        guard event.terminalId == terminalId else { return }
        switch event {
        case .data(_, let text, let skipped):
            if skipped > 0 {
                // The computer dropped part of a flood: read where it stands now.
                if Date().timeIntervalSince(lastResync) > 1 {
                    lastResync = Date()
                    Task { await refresh() }
                }
                return
            }
            screen.feed(text)
            version += 1
        case .exit(_, let code):
            state = .exited(code)
            token = nil
            version += 1
        }
    }

    // MARK: Typing

    /// Raw input: what a key or the command line produced.
    public func send(_ text: String) {
        guard !text.isEmpty else { return }
        for part in TerminalKeys.chunks(text) { queue.append(.write(part)) }
        drain()
    }

    public func key(_ key: TerminalKey) {
        if let bytes = TerminalKeys.bytes(key, appCursor: screen.appCursor) { send(bytes) }
    }

    public func paste(_ text: String) {
        send(TerminalKeys.paste(text, bracketed: screen.bracketedPaste))
    }

    /// The command line: the whole line, then Return.
    public func sendLine(_ text: String) {
        send(TerminalKeys.line(text))
    }

    /// The phone's screen fits `cols` × `rows`: the terminal follows.
    public func resize(cols: Int, rows: Int) {
        guard canType, cols > 0, rows > 0, cols != screen.cols || rows != screen.rows else { return }
        screen.resize(cols: min(cols, TerminalLimits.maxCols), rows: min(rows, TerminalLimits.maxRows))
        version += 1
        queue.removeAll { if case .resize = $0 { return true } else { return false } }
        queue.append(.resize(screen.cols, screen.rows))
        drain()
    }

    private func drain() {
        guard !draining else { return }
        draining = true
        Task { @MainActor in
            while !queue.isEmpty {
                let op = queue.removeFirst()
                await perform(op)
            }
            draining = false
        }
    }

    private func request(_ op: Op, token: String) -> (String, [JSONValue]) {
        switch op {
        case .write(let s): return TerminalRequest.write(terminalId, s, token: token)
        case .resize(let c, let r): return TerminalRequest.resize(terminalId, cols: c, rows: r, token: token)
        }
    }

    private func perform(_ op: Op) async {
        guard state == .live, let token else { return }
        let (channel, args) = request(op, token: token)
        do {
            _ = try await backend.read(channel, args)
            error = nil
        } catch let refused where TerminalRefusal.needsReopen(refused) {
            // The token ended (idle, too old, the computer restarted): open again, then retry once.
            do {
                try await reopen()
                guard let fresh = self.token else { return }
                let (c, a) = request(op, token: fresh)
                _ = try await backend.read(c, a)
                self.error = nil
            } catch {
                self.error = Self.describe(error, computer: backend.computerName)
            }
        } catch {
            self.error = Self.describe(error, computer: backend.computerName)
        }
    }

    // MARK: Leaving

    /// Stop watching: the desktop's badge goes, the size it had comes back.
    public func leave() async {
        if let sub = subscription {
            backend.unsubscribeTerminal(sub)
            subscription = nil
        }
        guard state == .live || token != nil else { return }
        if let size = originalSize, let token, size.cols != screen.cols || size.rows != screen.rows {
            let (channel, args) = TerminalRequest.resize(terminalId, cols: size.cols, rows: size.rows, token: token)
            _ = try? await backend.read(channel, args)
        }
        let (channel, args) = TerminalRequest.leave(terminalId)
        _ = try? await backend.read(channel, args)
        token = nil
        if case .live = state { state = .closed }
    }

    /// Close the terminal on the computer (a Change action).
    public func close() async throws {
        let (channel, args) = TerminalRequest.close(terminalId)
        _ = try await backend.change(channel, args)
        token = nil
        state = .closed
        if let sub = subscription {
            backend.unsubscribeTerminal(sub)
            subscription = nil
        }
    }

    /// The connection came back: the computer forgot this phone's session, so open it again.
    public func reconnected() async {
        guard state == .live || state == .opening else { return }
        do {
            try await reopen()
        } catch {
            state = .failed(Self.describe(error, computer: backend.computerName))
        }
    }

    /// An error as the owner should read it.
    public static func describe(_ error: Error, computer: String) -> String {
        let code = (error as? ChangeRefused)?.code ?? TerminalRefusal.code(error)
        if let code, let m = TerminalRefusal.message(code, computer: computer) ?? PhoneRefusal(code: code)?.message(computer: computer) {
            return m
        }
        return error.localizedDescription
    }
}

extension PhoneRefusal {
    /// A refusal from its code alone.
    init?(code: String) {
        self.init("Not allowed from a paired phone (\(code)): ")
    }
}

/// The connected computer as the terminal screens' backend.
extension ComputersStore: TerminalBackend {
    public func read(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        try await remote().call(channel, args)
    }

    public func change(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        try await call(change: channel, args)
    }

    public var computerName: String { active?.name ?? "your computer" }
}
