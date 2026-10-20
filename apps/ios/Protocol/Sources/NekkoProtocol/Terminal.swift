import Foundation

// Terminals and SSH on the phone (IO-33 FA-3, FA-6), as the computer projects
// them for phones (packages/shared/src/phone-terminal.ts): one chat's
// terminals without paths, a capped tail, SSH hosts without user names, and
// the live `terminal:event` output of the terminals this phone opened.
//
// Opening a terminal (`terminal:open`, `terminal:create`, `ssh:open`) is a
// Change action (one Face ID within 5 minutes) and answers a token; typing
// (`terminal:write`) and resizing carry that token instead of a proof each.

public enum TerminalChannels {
    public static let list = "terminals:list"
    public static let tail = "terminal:tail"
    public static let create = "terminal:create"
    public static let write = "terminal:write"
    public static let resize = "terminal:resize"
    public static let signal = "terminal:signal"
    public static let close = "terminal:close"
    /// Answered by the computer's gate: attach to a terminal (Change, signed).
    public static let open = "terminal:open"
    /// Answered by the computer's gate: stop watching a terminal (no proof).
    public static let leave = "terminal:leave"
    public static let sshHosts = "ssh:hosts"
    public static let sshOpen = "ssh:open"
    /// The output of the terminals this phone opened (and only those).
    public static let event = "terminal:event"
}

/// The computer's limits for terminals on a phone (`PHONE_TERMINAL`).
public enum TerminalLimits {
    public static let writeBytes = 64 * 1024
    public static let maxCols = 500
    public static let maxRows = 300
}

/// A terminal as the phone sees it: the folder's name, never its path.
public struct PhoneTerminal: Equatable, Sendable, Identifiable, Hashable {
    public enum Kind: String, Sendable { case shell, ssh, agent }
    public let id: String
    public let title: String
    public let kind: Kind
    public let folder: String
    public let shell: String
    public let running: Bool
    public let exitCode: Int?
    public let createdAt: Int64?
    public let sessionId: String?
    /// Phones attached right now.
    public let viewers: Int

    public init(id: String, title: String, kind: Kind = .shell, folder: String = "", shell: String = "", running: Bool = true,
                exitCode: Int? = nil, createdAt: Int64? = nil, sessionId: String? = nil, viewers: Int = 0) {
        self.id = id
        self.title = title
        self.kind = kind
        self.folder = folder
        self.shell = shell
        self.running = running
        self.exitCode = exitCode
        self.createdAt = createdAt
        self.sessionId = sessionId
        self.viewers = viewers
    }

    /// The agent's command log: read only on the phone.
    public var readOnly: Bool { kind == .agent }

    /// What the list shows under the title.
    public var detail: String {
        var parts: [String] = []
        switch kind {
        case .agent: parts.append("Agent commands")
        case .ssh: parts.append("SSH")
        case .shell: if !shell.isEmpty { parts.append(shell) }
        }
        if !folder.isEmpty && kind != .agent { parts.append(folder) }
        if !running { parts.append(exitCode.map { "exited (\($0))" } ?? "exited") }
        return parts.joined(separator: " · ")
    }

    public static func from(_ v: JSONValue?) -> PhoneTerminal? {
        guard let v, let id = v.str("id") else { return nil }
        return PhoneTerminal(id: id, title: v.str("title") ?? "", kind: Kind(rawValue: v.str("kind") ?? "") ?? .shell,
                             folder: v.str("folder") ?? "", shell: v.str("shell") ?? "", running: v.flag("running"),
                             exitCode: v.long("exitCode").map { Int($0) }, createdAt: v.long("createdAt"),
                             sessionId: v.str("sessionId"), viewers: Int(v.long("viewers") ?? 0))
    }

    public static func list(_ v: JSONValue?) -> [PhoneTerminal] {
        (v?.array ?? []).compactMap { from($0) }
    }
}

/// A host from the computer's `~/.ssh/config`: alias and where it goes, no user.
public struct SshHost: Equatable, Sendable, Identifiable, Hashable {
    public let alias: String
    public let hostName: String?
    public let port: Int?
    public var id: String { alias }

    public init(alias: String, hostName: String? = nil, port: Int? = nil) {
        self.alias = alias
        self.hostName = hostName
        self.port = port
    }

    /// `devbox.lan:2222`, or nothing when the alias says it all.
    public var detail: String? {
        guard let hostName, !hostName.isEmpty else { return port.map { "port \($0)" } }
        return port.map { "\(hostName):\($0)" } ?? hostName
    }

    public static func list(_ v: JSONValue?) -> [SshHost] {
        (v?.array ?? []).compactMap { h in
            guard let alias = h.str("alias"), !alias.isEmpty else { return nil }
            return SshHost(alias: alias, hostName: h.str("hostName"), port: h.long("port").map { Int($0) })
        }
    }
}

/// `terminal:tail`: the newest scroll-back (at most 64 KB), cut cleanly by the computer.
public struct TerminalTail: Equatable, Sendable {
    public let terminal: PhoneTerminal?
    public let buffer: String
    public let cols: Int
    public let rows: Int
    public let truncated: Bool

    public init(terminal: PhoneTerminal?, buffer: String, cols: Int, rows: Int, truncated: Bool = false) {
        self.terminal = terminal
        self.buffer = buffer
        self.cols = cols
        self.rows = rows
        self.truncated = truncated
    }

    public static func from(_ v: JSONValue?) -> TerminalTail? {
        guard let v, v.object != nil else { return nil }
        return TerminalTail(terminal: PhoneTerminal.from(v["terminal"]), buffer: v.str("buffer") ?? "",
                            cols: Int(v.long("cols") ?? 80), rows: Int(v.long("rows") ?? 24), truncated: v.flag("truncated"))
    }
}

/// What opening a terminal answers: its tail and the token for typing into it.
public struct TerminalOpened: Equatable, Sendable {
    public let tail: TerminalTail
    public let token: String
    public let idleMs: Int64
    public let maxMs: Int64

    public init(tail: TerminalTail, token: String, idleMs: Int64 = 300_000, maxMs: Int64 = 1_800_000) {
        self.tail = tail
        self.token = token
        self.idleMs = idleMs
        self.maxMs = maxMs
    }

    public static func from(_ v: JSONValue?) -> TerminalOpened? {
        guard let tail = TerminalTail.from(v), let token = v?.str("token"), !token.isEmpty else { return nil }
        return TerminalOpened(tail: tail, token: token, idleMs: v?.long("idleMs") ?? 300_000, maxMs: v?.long("maxMs") ?? 1_800_000)
    }
}

/// One `terminal:event`.
public enum TerminalEvent: Equatable, Sendable {
    /// Output. `skipped` > 0: the computer dropped that much (a flood); read the tail again.
    case data(terminalId: String, text: String, skipped: Int)
    case exit(terminalId: String, code: Int?)

    public var terminalId: String {
        switch self {
        case .data(let id, _, _), .exit(let id, _): return id
        }
    }

    public static func from(_ payload: JSONValue) -> TerminalEvent? {
        guard let id = payload.str("terminalId") else { return nil }
        switch payload.str("type") {
        case "data": return .data(terminalId: id, text: payload.str("data") ?? "", skipped: Int(payload.long("skipped") ?? 0))
        case "exit": return .exit(terminalId: id, code: payload.long("code").map { Int($0) })
        default: return nil
        }
    }
}

/// The calls a terminal screen makes, as `(channel, args)`.
public enum TerminalRequest {
    static func size(_ cols: Int, _ rows: Int) -> (Int64, Int64) {
        (Int64(min(max(cols, 1), TerminalLimits.maxCols)), Int64(min(max(rows, 1), TerminalLimits.maxRows)))
    }

    /// One chat's terminals (the computer refuses a list without a chat).
    public static func list(sessionId: String) -> (String, [JSONValue]) {
        (TerminalChannels.list, [["sessionId": .string(sessionId)]])
    }

    public static func tail(_ id: String) -> (String, [JSONValue]) {
        (TerminalChannels.tail, [.string(id)])
    }

    public static func open(_ id: String) -> (String, [JSONValue]) {
        (TerminalChannels.open, [.string(id)])
    }

    public static func leave(_ id: String) -> (String, [JSONValue]) {
        (TerminalChannels.leave, [.string(id)])
    }

    /// A new terminal in the chat's folder (the computer picks the folder and the shell).
    public static func create(sessionId: String, cols: Int, rows: Int) -> (String, [JSONValue]) {
        let (c, r) = size(cols, rows)
        return (TerminalChannels.create, [["sessionId": .string(sessionId), "cols": .int(c), "rows": .int(r)]])
    }

    public static func sshOpen(alias: String, sessionId: String, cols: Int, rows: Int) -> (String, [JSONValue]) {
        let (c, r) = size(cols, rows)
        return (TerminalChannels.sshOpen, [.string(alias), ["sessionId": .string(sessionId), "cols": .int(c), "rows": .int(r)]])
    }

    public static func write(_ id: String, _ data: String, token: String) -> (String, [JSONValue]) {
        (TerminalChannels.write, [.string(id), .string(data), .string(token)])
    }

    public static func resize(_ id: String, cols: Int, rows: Int, token: String) -> (String, [JSONValue]) {
        let (c, r) = size(cols, rows)
        return (TerminalChannels.resize, [.string(id), .int(c), .int(r), .string(token)])
    }

    public static func signal(_ id: String) -> (String, [JSONValue]) {
        (TerminalChannels.signal, [.string(id)])
    }

    public static func close(_ id: String) -> (String, [JSONValue]) {
        (TerminalChannels.close, [.string(id)])
    }

    public static func hosts() -> (String, [JSONValue]) {
        (TerminalChannels.sshHosts, [])
    }
}

/// Keys of the key row, as the bytes a terminal expects.
public enum TerminalKey: Equatable, Sendable {
    case escape, tab, enter, backspace
    case up, down, left, right, home, end, pageUp, pageDown
    /// Ctrl and a key: `c` is Ctrl-C (ETX).
    case ctrl(Character)
}

public enum TerminalKeys {
    /// The bytes for `key`. `appCursor`: the program asked for application cursor keys (DECCKM).
    public static func bytes(_ key: TerminalKey, appCursor: Bool = false) -> String? {
        let csi = appCursor ? "\u{1b}O" : "\u{1b}["
        switch key {
        case .escape: return "\u{1b}"
        case .tab: return "\t"
        case .enter: return "\r"
        case .backspace: return "\u{7f}"
        case .up: return csi + "A"
        case .down: return csi + "B"
        case .right: return csi + "C"
        case .left: return csi + "D"
        case .home: return csi + "H"
        case .end: return csi + "F"
        case .pageUp: return "\u{1b}[5~"
        case .pageDown: return "\u{1b}[6~"
        case .ctrl(let c): return control(c)
        }
    }

    /// Ctrl plus a character: letters and `@[\]^_` map to C0, `?` to DEL, space to NUL.
    public static func control(_ c: Character) -> String? {
        guard let a = c.lowercased().unicodeScalars.first, c.unicodeScalars.count == 1 else { return nil }
        switch a.value {
        case 0x61...0x7a: return String(Character(Unicode.Scalar(UInt8(a.value - 0x60))))
        case 0x40: return "\u{0}"
        case 0x20: return "\u{0}"
        case 0x5b: return "\u{1b}"
        case 0x5c: return "\u{1c}"
        case 0x5d: return "\u{1d}"
        case 0x5e: return "\u{1e}"
        case 0x5f: return "\u{1f}"
        case 0x3f: return "\u{7f}"
        default: return nil
        }
    }

    /// Pasted text: line ends become Return, wrapped in bracketed-paste
    /// markers when the program asked for them (so a shell doesn't run each
    /// line); a pasted end marker is removed so text can't escape the paste.
    public static func paste(_ text: String, bracketed: Bool) -> String {
        let body = text.replacingOccurrences(of: "\u{1b}[201~", with: "")
            .replacingOccurrences(of: "\r\n", with: "\r")
            .replacingOccurrences(of: "\n", with: "\r")
        return bracketed ? "\u{1b}[200~" + body + "\u{1b}[201~" : body
    }

    /// A typed or dictated command line, sent with Return.
    public static func line(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: " ").replacingOccurrences(of: "\n", with: " ") + "\r"
    }

    /// `text` in parts of at most `maxBytes` UTF-8 bytes, never splitting a character.
    public static func chunks(_ text: String, maxBytes: Int = TerminalLimits.writeBytes) -> [String] {
        guard text.utf8.count > maxBytes else { return text.isEmpty ? [] : [text] }
        var out: [String] = []
        var part = ""
        var size = 0
        for ch in text {
            let n = String(ch).utf8.count
            if size + n > maxBytes && !part.isEmpty {
                out.append(part)
                part = ""
                size = 0
            }
            part.append(ch)
            size += n
        }
        if !part.isEmpty { out.append(part) }
        return out
    }
}

/// A refusal of a terminal call that opening the terminal again fixes: the
/// token ended (idle, too old) or the computer forgot it (a restart, a
/// reconnect).
public enum TerminalRefusal {
    public static let reopenCodes: Set<String> = ["token-expired", "token-invalid", "token-required"]

    public static func code(_ error: Error) -> String? {
        if let e = error as? RelayError { return PhoneRefusal(e.message)?.code }
        return nil
    }

    public static func needsReopen(_ error: Error) -> Bool {
        code(error).map { reopenCodes.contains($0) } ?? false
    }

    /// What to tell the owner for a terminal refusal, or nil for the computer's message.
    public static func message(_ code: String, computer: String) -> String? {
        switch code {
        case "terminal-hidden": return "\(computer) doesn’t share that terminal with phones. Only a chat’s terminals open here."
        case "token-expired", "token-invalid", "token-required": return "This terminal needs Face ID again. Open it again to keep typing."
        default: return nil
        }
    }
}
