import Foundation

/// One event of a chat's audit trail (`audit:read`), as the computer writes it
/// (crates/nekkod/src/audit.rs): value-free by design, so no arguments, URLs,
/// reasons, output or message text. Mirrors the desktop's `auditTrailLines.ts`.
public struct AuditEvent: Equatable, Sendable, Identifiable {
    /// Who answered an approval.
    public struct By: Equatable, Sendable {
        public let via: String
        public let device: String?
        /// The device's current name in Paired devices, added by `audit:read`.
        public let deviceName: String?

        public init(via: String, device: String? = nil, deviceName: String? = nil) {
            self.via = via
            self.device = device
            self.deviceName = deviceName
        }

        static func from(_ v: JSONValue?) -> By? {
            guard let v, let via = v.str("via") else { return nil }
            return By(via: via, device: v.str("device"), deviceName: v.str("deviceName"))
        }
    }

    /// What a tool call touched, never what it carried.
    public struct Detail: Equatable, Sendable {
        public var host: String?
        public var path: String?
        public var program: String?
        public var action: String?
        public var server: String?
        public var recipients: Int?

        public init(host: String? = nil, path: String? = nil, program: String? = nil, action: String? = nil, server: String? = nil, recipients: Int? = nil) {
            self.host = host
            self.path = path
            self.program = program
            self.action = action
            self.server = server
            self.recipients = recipients
        }

        static func from(_ v: JSONValue?) -> Detail {
            Detail(host: v?.str("host"), path: v?.str("path"), program: v?.str("program"), action: v?.str("action"),
                   server: v?.str("server"), recipients: v?.long("recipients").map(Int.init))
        }
    }

    public struct Count: Equatable, Sendable {
        public let kind: String
        public let count: Int
    }

    public enum Kind: Equatable, Sendable {
        case turn(mode: String?, model: String?, claudeCode: Bool)
        case tool(name: String, isError: Bool, ms: Int?, detail: Detail)
        case approval(tool: String?, severity: String?, answer: String, by: By?)
        case permission(tool: String, decision: String, by: By?, detail: Detail)
        case taint(by: String)
        case redactions([Count])
    }

    /// Its place in the trail, so two events at the same millisecond stay apart.
    public let id: Int
    /// When, in milliseconds since 1970.
    public let at: Int64
    public let turnId: String
    public let kind: Kind

    public init(id: Int, at: Int64, turnId: String, kind: Kind) {
        self.id = id
        self.at = at
        self.turnId = turnId
        self.kind = kind
    }

    /// The trail as `audit:read` answers it; an event of a type this app does
    /// not know, or missing what it needs, is skipped.
    public static func trail(_ v: JSONValue?) -> [AuditEvent] {
        (v?.array ?? []).enumerated().compactMap { i, e in from(e, id: i) }
    }

    static func from(_ e: JSONValue, id: Int) -> AuditEvent? {
        guard e.object != nil else { return nil }
        let kind: Kind
        switch e.str("type") {
        case "turn":
            kind = .turn(mode: e.str("mode"), model: e.str("model"), claudeCode: e.flag("claudeCode"))
        case "tool":
            guard let name = e.str("tool") else { return nil }
            kind = .tool(name: name, isError: e.flag("isError"), ms: e.long("ms").map(Int.init), detail: .from(e["detail"]))
        case "approval":
            kind = .approval(tool: e.str("tool"), severity: e.str("severity"), answer: e.str("answer") ?? "unanswered", by: .from(e["by"]))
        case "permission":
            guard let tool = e.str("tool") else { return nil }
            kind = .permission(tool: tool, decision: e.str("decision") ?? "", by: .from(e["by"]), detail: .from(e["detail"]))
        case "taint":
            kind = .taint(by: e.str("by") ?? "")
        case "redactions":
            let counts = (e["counts"]?.object ?? [:])
                .compactMap { k, n in n.int64.map { Count(kind: k, count: Int($0)) } }
                .sorted { $0.kind < $1.kind }
            kind = .redactions(counts)
        default:
            return nil
        }
        return AuditEvent(id: id, at: e.long("at") ?? 0, turnId: e.str("turnId") ?? "", kind: kind)
    }

    /// Approvals and Claude Code permissions: the "Approvals" filter.
    public var isDecision: Bool {
        switch kind {
        case .approval, .permission: return true
        default: return false
        }
    }
}

/// A turn and the events it wrote, oldest first.
public struct AuditTurn: Equatable, Sendable, Identifiable {
    public let id: Int
    public let turnId: String
    public var start: AuditEvent?
    public var events: [AuditEvent]

    /// Group a trail by turn, keeping the order it was written in.
    public static func group(_ trail: [AuditEvent]) -> [AuditTurn] {
        var turns: [AuditTurn] = []
        for e in trail {
            let isStart: Bool = { if case .turn = e.kind { return true } else { return false } }()
            if turns.isEmpty || turns[turns.count - 1].turnId != e.turnId || isStart {
                turns.append(AuditTurn(id: e.id, turnId: e.turnId, start: nil, events: []))
            }
            if isStart { turns[turns.count - 1].start = e } else { turns[turns.count - 1].events.append(e) }
        }
        return turns
    }
}

/// How a row of the audit trail reads: what happened, quieter detail, and a tone for its mark.
public struct AuditLine: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case neutral, good, warn, bad }
    public let text: String
    public let detail: String?
    public let tone: Tone

    public init(_ text: String, _ detail: String? = nil, _ tone: Tone = .neutral) {
        self.text = text
        self.detail = detail.flatMap { $0.isEmpty ? nil : $0 }
        self.tone = tone
    }

    /// Who answered, in words: by the device's current name when it has one,
    /// else its id (a device no longer paired).
    public static func by(_ by: AuditEvent.By?) -> String {
        guard let by else { return String(localized: "nobody answered") }
        let name = by.deviceName?.trimmingCharacters(in: .whitespaces)
        switch by.via {
        case "this computer": return String(localized: "on this computer")
        case "phone":
            if let name, !name.isEmpty { return String(localized: "on \(name) (phone)") }
            if let d = by.device { return String(localized: "on a phone (\(d))") }
            return String(localized: "on a phone")
        case "paired computer":
            if let name, !name.isEmpty { return String(localized: "on \(name) (paired computer)") }
            if let d = by.device { return String(localized: "on a paired computer (\(d))") }
            return String(localized: "on a paired computer")
        case "telegram": return String(localized: "in Telegram")
        case "yolo": return String(localized: "by YOLO, without asking")
        case "workflow policy": return String(localized: "by the workflow’s policy")
        case "mode": return String(localized: "by the chat’s mode")
        case "rule": return String(localized: "by a guardrail rule")
        default: return String(localized: "via \(by.via)")
        }
    }

    /// What a tool call touched, from its value-free detail.
    static func touched(_ d: AuditEvent.Detail) -> String? {
        var parts = [d.host, d.path, d.program, d.action].compactMap { $0 }
        if let s = d.server { parts.append(String(localized: "server \(s)")) }
        if let n = d.recipients, n > 0 { parts.append(n == 1 ? String(localized: "1 recipient") : String(localized: "\(n) recipients")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// One event as a row.
    public static func of(_ e: AuditEvent) -> AuditLine {
        switch e.kind {
        case let .turn(mode, model, claudeCode):
            let detail = [claudeCode ? "Claude Code" : nil, model].compactMap { $0 }.joined(separator: " · ")
            return AuditLine(String(localized: "Turn started in \(mode ?? "guardrails")"), detail)
        case let .tool(name, isError, ms, detail):
            let parts = [touched(detail), ms.map { "\($0) ms" }].compactMap { $0 }
            return AuditLine(isError ? String(localized: "\(name) failed") : String(localized: "Ran \(name)"),
                             parts.joined(separator: " · "), isError ? .warn : .neutral)
        case let .approval(tool, severity, answer, by):
            var what = tool ?? String(localized: "a tool")
            if let severity { what += " (\(severity))" }
            switch answer {
            case "approved":
                return AuditLine(String(localized: "Asked before \(what): approved"), Self.by(by), by?.via == "yolo" ? .warn : .good)
            case "denied":
                return AuditLine(String(localized: "Asked before \(what): denied"), Self.by(by), .bad)
            default:
                return AuditLine(String(localized: "Asked before \(what): no answer"), String(localized: "stopped before anyone answered"))
            }
        case let .permission(tool, decision, by, detail):
            let tone: Tone = decision == "denied" ? .bad : decision == "approved" ? .good : .neutral
            return AuditLine(String(localized: "Claude Code asked to use \(tool): \(decision)"),
                             [touched(detail), Self.by(by)].compactMap { $0 }.joined(separator: " · "), tone)
        case let .taint(by):
            return AuditLine(String(localized: "Read content from outside this computer"),
                             String(localized: "via \(by); sending data out now asks first"), .warn)
        case let .redactions(counts):
            let parts = counts.map { "\($0.count) \($0.kind.lowercased().replacingOccurrences(of: "_", with: " "))" }
            return AuditLine(String(localized: "Privacy Shield hid values before they left"), parts.joined(separator: ", "), .good)
        }
    }
}
