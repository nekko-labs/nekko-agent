import Foundation

/// What the agent-work rows of a chat read from a tool call beyond its label:
/// a watch's target and timer, a subagent's title and model. Ports of the
/// desktop's `agentWatches.ts`, `SubagentCue.tsx` and `subagentActivity.ts`,
/// so the phone shows the same words. Pure, so the rows are testable here.
public enum AgentRows {
    public static let watchTool = "agent_watch"
    public static let subagentTool = "spawn_agent"

    // MARK: Watches

    /// An `agent_watch` call as the row reads it.
    public struct WatchCall: Equatable, Sendable {
        public enum Action: String, Sendable { case create, list, cancel, unknown }
        public var action: Action
        public var kind: AgentWatch.Kind?
        public var url: String?
        /// Timer delay or PR maximum wait, in seconds.
        public var seconds: Double?
        public var prompt: String
        /// The id this call armed or cancelled, once its result is in.
        public var id: String?
    }

    public static func parseWatch(_ input: [String: JSONValue], output: String?, failed: Bool = false) -> WatchCall {
        let action = input["action"]?.string.flatMap(WatchCall.Action.init(rawValue:)) ?? .unknown
        let kind = input["kind"]?.string.flatMap(AgentWatch.Kind.init(rawValue:))
        let raw: Double? = switch kind {
        case .timer?: input["delay_seconds"]?.double ?? 300
        case .pr?: input["timeout_seconds"]?.double ?? 3600
        case nil: nil
        }
        var id: String?
        if !failed, let output, let r = output.range(of: #"Watch (?:already )?armed: ([\w-]+)"#, options: .regularExpression) {
            id = String(output[r]).split(separator: " ").last.map(String.init)
        }
        if id == nil, action == .cancel { id = input["id"]?.string }
        return WatchCall(action: action, kind: kind, url: input["url"]?.string, seconds: raw.flatMap { $0.isFinite ? $0 : nil },
                         prompt: input["prompt"]?.string ?? "", id: id)
    }

    /// "PR #555" and "owner/repo#555" from a GitHub pull request address.
    public static func prLabel(_ url: String?) -> (short: String, full: String)? {
        guard let url, let r = url.range(of: #"github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)"#, options: .regularExpression) else { return nil }
        let parts = url[r].split(separator: "/")
        guard parts.count >= 5, let n = Int(parts[4]) else { return nil }
        return ("PR #\(n)", "\(parts[1])/\(parts[2])#\(n)")
    }

    /// `fmtSpan`: "42s", "4m 10s", "12 min", "1h 05m", "3 days".
    public static func span(ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 10 { return "\(m)m " + String(format: "%02ds", s % 60) }
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h < 48 { return m % 60 != 0 ? "\(h)h " + String(format: "%02dm", m % 60) : "\(h)h" }
        return "\(Int((Double(h) / 24).rounded())) days"
    }

    /// What the watch is looking at and what makes it fire, in one line.
    public static func watchHeadline(_ w: WatchCall, failed: String? = nil) -> String {
        if let failed {
            let reason = failed.replacingOccurrences(of: "Agent watch failed: ", with: "")
            return "Watch not armed · " + String(reason.prefix(120))
        }
        switch w.action {
        case .list: return "Checked this chat’s watches"
        case .cancel: return ("Cancelled watch " + (w.id.map { String($0.prefix(8)) } ?? "")).trimmingCharacters(in: .whitespaces)
        case .create, .unknown: break
        }
        let limit = w.seconds.map { span(ms: $0 * 1000) } ?? ""
        switch w.kind {
        case .pr?:
            let pr = prLabel(w.url)?.short ?? "a pull request"
            return "Watching \(pr) · wakes on any PR change" + (limit.isEmpty ? "" : " or after \(limit)")
        case .timer?:
            return "Timer watch · wakes after " + (limit.isEmpty ? "its delay" : limit)
        case nil:
            return "Agent watch"
        }
    }

    /// The first sentence of a prompt, in a few words: what the agent does when it wakes.
    public static func thenSummary(_ prompt: String, words: Int = 40) -> String {
        let sentence = compactSentence(prompt, limit: 400)
        guard !sentence.isEmpty else { return "" }
        let parts = sentence.split(separator: " ")
        return parts.count > words ? parts.prefix(words).joined(separator: " ") + "…" : sentence
    }

    /// `compactSentence`: whitespace folded, cut at the first sentence end, at most `limit` characters.
    public static func compactSentence(_ text: String, limit: Int = 140) -> String {
        let clean = text.prefix(2000).split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        var sentence = clean
        if let r = clean.range(of: #"^.*?[.!?](?=\s|$)"#, options: .regularExpression) { sentence = String(clean[r]) }
        return sentence.count > limit ? String(sentence.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" : sentence
    }

    public enum Tone: Sendable, Equatable { case normal, warn, danger, quiet }
    public struct Clock: Equatable, Sendable {
        public let text: String
        public let tone: Tone
        public let detail: String
        /// Whether the text changes with time (so the row re-renders each second).
        public let ticking: Bool
    }

    /// The chip an armed watch wears: time left, overdue, due, triggered, cancelled, failed.
    public static func watchClock(_ w: WatchCall, view: AgentWatch?, now: Int64) -> Clock? {
        guard let view else { return nil }
        switch view.status {
        case .done: return Clock(text: "triggered", tone: .quiet, detail: "This watch fired and woke the chat.", ticking: false)
        case .cancelled: return Clock(text: "cancelled", tone: .quiet, detail: view.lastError.map { "Cancelled: \($0)" } ?? "This watch was cancelled.", ticking: false)
        case .error: return Clock(text: "failed to wake", tone: .danger, detail: "The wake-up could not be delivered" + (view.lastError.map { ": \($0)" } ?? "."), ticking: false)
        case .active: break
        }
        let late = Double(now - view.deadlineAt)
        let lastError = view.lastError.map { " Last error: \($0)" } ?? ""
        if view.pending {
            return Clock(text: "due · waiting for the chat", tone: late > 120_000 || view.failures > 0 ? .warn : .normal,
                         detail: "Triggered; waiting for the chat to be free before continuing." + lastError, ticking: true)
        }
        // The scheduler polls every 15 s, so a minute's grace before calling it late.
        if late > 60_000 {
            return Clock(text: "overdue \(span(ms: late))", tone: .warn, detail: "Expected to wake by \(time(view.deadlineAt)). Is the app or engine running?" + lastError, ticking: true)
        }
        let left = max(0, Double(view.deadlineAt - now))
        let retrying = view.failures > 0 ? " · retrying" : ""
        let prefix = w.kind == .pr ? "≤ " : ""
        let when = w.kind == .pr ? "Wakes on a PR change, or at \(time(view.deadlineAt)) at the latest." : "Wakes at \(time(view.deadlineAt))."
        return Clock(text: "\(prefix)\(span(ms: left)) left\(retrying)", tone: view.failures > 0 ? .warn : .normal, detail: when + lastError, ticking: true)
    }

    static func time(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .omitted, time: .shortened)
    }

    // MARK: Wake-ups

    /// A `[Agent watch <id>]` wake-up the computer sent as a user turn.
    public struct Wake: Equatable, Sendable {
        public let id: String
        public let trigger: String
        public let detail: String
        public let prompt: String
        public let url: String?
    }

    public static func isWake(_ content: String) -> Bool { parseWake(content) != nil }

    public static func parseWake(_ content: String) -> Wake? {
        guard content.hasPrefix("[Agent watch "), let close = content.firstIndex(of: "]") else { return nil }
        let id = String(content[content.index(content.startIndex, offsetBy: 13)..<close])
        guard !id.isEmpty, !id.contains("\n") else { return nil }
        var body = content[content.index(after: close)...]
        if body.hasPrefix("\n") { body = body.dropFirst() }
        let marker = "\n\nContinuation requested when armed:\n"
        var reason = String(body)
        var prompt = ""
        if let r = body.range(of: marker) {
            reason = String(body[..<r.lowerBound])
            prompt = String(body[r.upperBound...])
            if let p = prompt.range(of: "\n\nThis wake-up grants no new permissions.") { prompt = String(prompt[..<p.lowerBound]) }
        }
        reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = reason.range(of: #"^PR state changed for (\S+?)\.? Fetch the latest details before acting\. Snapshot: "#, options: .regularExpression) {
            let head = String(reason[r])
            let url = head.replacingOccurrences(of: "PR state changed for ", with: "")
                .components(separatedBy: " Fetch").first.map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 } ?? ""
            let snapshot = String(reason[r.upperBound...])
            var parts: [String] = []
            if let snap = try? JSONValue.parse(snapshot) {
                if let s = snap.str("state") { parts.append(s) }
                if let c = snap.str("checks"), c != "none" { parts.append("checks \(c)") }
                if snap.flag("isDraft") { parts.append("draft") }
                if let d = snap.str("reviewDecision") { parts.append(d.lowercased().replacingOccurrences(of: "_", with: " ")) }
            }
            return Wake(id: id, trigger: "\(prLabel(url)?.short ?? "PR") changed", detail: parts.joined(separator: ", "), prompt: prompt, url: url)
        }
        if reason.hasPrefix("Watch deadline reached") {
            let error = reason.range(of: "Last polling error: ").map { String(reason[$0.upperBound...]) }
            return Wake(id: id, trigger: "Deadline reached", detail: error.map { "last polling error: \(compactSentence($0, limit: 80))" } ?? "", prompt: prompt, url: nil)
        }
        return Wake(id: id, trigger: "Woke up", detail: compactSentence(reason, limit: 100), prompt: prompt, url: nil)
    }

    // MARK: Subagents

    /// The delegation's title, else the first words of its task.
    public static func subagentTitle(_ input: [String: JSONValue]) -> String {
        if let t = input["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return compactSentence(t) }
        if let task = input["task"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !task.isEmpty { return compactSentence(task, limit: 60) }
        return "Subagent"
    }

    /// What the delegation is for: the task's first sentence.
    public static func subagentTask(_ input: [String: JSONValue]) -> String {
        guard let task = input["task"]?.string else { return "" }
        return compactSentence(task, limit: 140)
    }

    /// `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`; `org/model:latest` → `model`.
    public static func shortModelName(_ id: String) -> String {
        var tail = id.split(separator: "/").last.map(String.init) ?? id
        if tail.lowercased().hasSuffix(":latest") { tail = String(tail.dropLast(7)) }
        if let r = tail.range(of: #"-\d{8}$"#, options: .regularExpression) { tail = String(tail[..<r.lowerBound]) }
        return tail
    }

    public enum ModelSource: Sendable, Equatable { case child, requested, inherited }

    /// Which model a delegation ran on: the matched child chat, else the call's own
    /// `model_id`, else what an unrouted call inherits (the parent's model).
    public static func subagentModel(_ input: [String: JSONValue], child: SessionSummary?, children: [SessionSummary], inherited: String?) -> (id: String, source: ModelSource)? {
        if let m = child?.modelId, !m.isEmpty { return (m, .child) }
        let title = input["title"]?.string?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? input["task"]?.string?.trimmingCharacters(in: .whitespaces).prefix(40).description ?? ""
        if !title.isEmpty {
            let named = children.filter { $0.title == title }
            if named.count == 1, let m = named[0].modelId, !m.isEmpty { return (m, .child) }
        }
        if let m = input["model_id"]?.string?.trimmingCharacters(in: .whitespaces), !m.isEmpty { return (m, .requested) }
        if input["provider_id"] == nil, let inherited, !inherited.isEmpty { return (inherited, .inherited) }
        return nil
    }

    /// The child chat a delegation made, by title among this chat's children; nil when ambiguous.
    public static func subagentChild(_ input: [String: JSONValue], children: [SessionSummary]) -> SessionSummary? {
        let title = input["title"]?.string?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? input["task"]?.string?.trimmingCharacters(in: .whitespaces).prefix(40).description ?? ""
        guard !title.isEmpty else { return nil }
        let matches = children.filter { $0.title == title }
        return matches.count == 1 ? matches[0] : nil
    }

    public enum SubagentStatus: String, Sendable { case working, waiting, completed, failed, stopped }

    /// A child's status from what the phone knows: the call's result, the
    /// child's live activity, else that it waits. A stored reply alone never
    /// counts as completion (the desktop's rule).
    public static func subagentStatus(output: String?, failed: Bool, activity: Activity?, parentRunning: Bool) -> SubagentStatus {
        if failed { return .failed }
        if output != nil { return .completed }
        switch activity {
        case .needsYou?: return .waiting
        case .running?: return .working
        case nil: return parentRunning ? .working : .waiting
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
