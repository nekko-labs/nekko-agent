import Foundation

/// One step of the agent's plan (`agentPlan`, written with `update_plan`), as
/// the desktop's plan sheet draws it (packages/shared/src/training.ts `PlanStep`).
public struct PlanStep: Equatable, Sendable, Identifiable {
    public enum Status: String, Sendable { case pending, active, done, skipped }
    /// The step's place in the work loop, when the agent says.
    public enum Kind: String, Sendable, CaseIterable {
        case explore, build, verify, ship
        public var label: String { rawValue.capitalized }
    }
    /// The agent's explicit check of a step; a done step or a tool success is not one.
    public struct Verification: Equatable, Sendable {
        public enum Status: String, Sendable { case pending, active, passed, failed, blocked, unknown }
        public let status: Status
        public let device: String?
        public let detail: String?
        public let evidenceUrl: String?

        public init(status: Status, device: String? = nil, detail: String? = nil, evidenceUrl: String? = nil) {
            self.status = status
            self.device = device
            self.detail = detail
            self.evidenceUrl = evidenceUrl
        }

        /// The chip's words, the desktop's (`VerificationChip`): "Verified on macOS".
        public var label: String {
            let word = switch status {
            case .pending: "Check pending"
            case .active: "Checking"
            case .passed: "Verified"
            case .failed: "Check failed"
            case .blocked: "Check blocked"
            case .unknown: "Check unknown"
            }
            return device.map { "\(word) on \($0)" } ?? word
        }

        /// The evidence link, only when it is an http(s) URL.
        public var safeEvidence: URL? {
            guard let s = evidenceUrl, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
            return url
        }
    }

    public let id: String
    public var title: String
    public var status: Status
    public var kind: Kind?
    /// From 2 when a finished step was set active again (Verify sent the work back).
    public var pass: Int?
    public var verification: Verification?
    public var note: String?
    public let createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, title: String, status: Status, kind: Kind? = nil, pass: Int? = nil,
                verification: Verification? = nil, note: String? = nil, createdAt: Int64 = 0, updatedAt: Int64 = 0) {
        self.id = id
        self.title = title
        self.status = status
        self.kind = kind
        self.pass = pass
        self.verification = verification
        self.note = note
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Finished and skipped steps squeeze to their title.
    public var squeezed: Bool { status == .done || status == .skipped }
    /// The detail row: the check's own words, else the agent's note.
    public var detail: String? { [verification?.detail, note].compactMap { $0 }.first { !$0.isEmpty } }

    public static func from(_ v: JSONValue?) -> PlanStep? {
        guard let v, let id = v.str("id"), let title = v.str("title") else { return nil }
        var verification: Verification?
        if let r = v["verification"], let s = r.str("status") {
            verification = Verification(status: Verification.Status(rawValue: s) ?? .unknown, device: r.str("device"),
                                        detail: r.str("detail"), evidenceUrl: r.str("evidenceUrl"))
        }
        return PlanStep(id: id, title: title, status: v.str("status").flatMap(Status.init(rawValue:)) ?? .pending,
                        kind: v.str("kind").flatMap(Kind.init(rawValue:)), pass: v.long("pass").map(Int.init),
                        verification: verification, note: v.str("note"),
                        createdAt: v.long("createdAt") ?? 0, updatedAt: v.long("updatedAt") ?? 0)
    }

    public static func list(_ v: JSONValue?) -> [PlanStep] { v?.array?.compactMap(from) ?? [] }
}

/// A task in a project-management tool that the chat linked to.
public struct ProjectLink: Equatable, Sendable {
    public let url: String
    /// The task's own key where it has one ("NEK-412", "o/r#12"), else what it is ("Trello card").
    public let label: String
}

/// What one plan step produced, placed by the app rather than reported by the model.
public struct PlanStepLinks: Equatable, Sendable {
    public var prs: [String] = []
    public var projects: [ProjectLink] = []
    /// Sub-agent chats started while the step was being worked.
    public var subagents: [String] = []
    var isEmpty: Bool { prs.isEmpty && projects.isEmpty && subagents.isEmpty }
}

/// The plan sheet's logic, ported from the desktop (`claudeAgentPlan.ts`,
/// `planStepLinks.ts`, `PlanSheet.tsx`) so the phone draws the same plan.
public enum AgentPlan {
    /// Claude Code's provider kind (`CLAUDE_CODE_PROVIDER_KIND`).
    public static let claudeCodeKind = "claude-code"
    /// The id prefix of a step in a Claude Agent chat's activity plan (`phase:build`).
    public static let phasePrefix = "phase:"
    static let sent = phasePrefix + "sent"

    // MARK: Which plan the sheet shows

    /// The chat's own plan; on a Claude Agent chat without one, Claude Code's
    /// plan rebuilt from the transcript, else the activity plan of its latest request.
    public static func sheet(_ session: Session?, claudeCode: Bool, working: Bool) -> [PlanStep]? {
        guard let session else { return nil }
        if !session.agentPlan.isEmpty { return session.agentPlan }
        guard claudeCode else { return nil }
        return claudeCodeOwnPlan(session.messages) ?? activityPlan(session.messages, working: working)
    }

    /// The step being worked: the active one, else the next pending one, else the last.
    public static func current(_ plan: [PlanStep]) -> PlanStep? {
        plan.first { $0.status == .active } ?? plan.first { $0.status == .pending } ?? plan.last
    }

    /// Finished (done or skipped) steps, for "1 of 4 done".
    public static func finished(_ plan: [PlanStep]) -> Int { plan.filter(\.squeezed).count }

    /// The last reply was stopped and nothing runs: the active step shows paused.
    public static func paused(_ messages: [ChatMessage], running: Bool) -> Bool {
        !running && (messages.last { $0.role == "assistant" }?.interrupted ?? false)
    }

    // MARK: Claude Code

    private static let exploreTools: Set<String> = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "NotebookRead"]
    private static let buildTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit"]
    private static let shipCommand = #"\b(gh\s+pr\s+(create|merge|ready)|git\s+push)\b"#
    private static let verifyCommand = #"\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|eslint|clippy|cargo\s+(test|check|build|clippy|fmt)|npm\s+(run\s+)?(test|build|lint|typecheck|check)|go\s+(test|build|vet)|gh\s+pr\s+checks)\b"#
    private static let buildCommand = #"\bgit\s+(add|commit|mv|rm)\b"#

    /// Where one of Claude Code's tool calls sits in the work loop; nil for its own bookkeeping.
    public static func phase(of call: ToolCall) -> PlanStep.Kind? {
        if exploreTools.contains(call.name) { return .explore }
        if buildTools.contains(call.name) { return .build }
        guard call.name == "Bash" else { return nil }
        let command = call.input["command"]?.string ?? ""
        func has(_ pattern: String) -> Bool { command.range(of: pattern, options: .regularExpression) != nil }
        if has(shipCommand) { return .ship }
        if has(verifyCommand) { return .verify }
        if has(buildCommand) { return .build }
        return .explore
    }

    private static let phases: [(kind: PlanStep.Kind, title: String, note: @Sendable (Int) -> String)] = [
        (.explore, "Look through the code", { "\($0) read\($0 == 1 ? "" : "s") and searches" }),
        (.build, "Make the changes", { "\($0) edit\($0 == 1 ? "" : "s")" }),
        (.verify, "Check the work", { "\($0) check\($0 == 1 ? "" : "s") run" }),
        (.ship, "Open a pull request", { _ in "" }),
    ]

    private static func firstLine(_ text: String) -> String {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static func taskId(_ output: String) -> String? {
        guard let r = output.range(of: #"Task #\S+ created"#, options: .regularExpression) else { return nil }
        return String(output[r].dropFirst("Task #".count).dropLast(" created".count))
    }

    /// Claude Code's own plan, rebuilt from its successful `TodoWrite` and
    /// `TaskCreate`/`TaskUpdate` calls (the steps nekkod keeps as `agentPlan`).
    public static func claudeCodeOwnPlan(_ messages: [ChatMessage]) -> [PlanStep]? {
        var calls: [String: ToolCall] = [:]
        for m in messages { for c in m.toolCalls { calls[c.id] = c } }
        func status(_ s: String?) -> PlanStep.Status { s == "completed" ? .done : s == "in_progress" ? .active : .pending }
        var plan: [PlanStep]?
        for m in messages {
            guard let r = m.toolResult, !r.isError, let call = calls[r.toolCallId] else { continue }
            let input = call.input
            let at = m.createdAt ?? 0
            switch call.name {
            case "TodoWrite":
                let todos = (input["todos"]?.array ?? []).compactMap { t -> (String, String?)? in
                    guard let c = t.str("content")?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty else { return nil }
                    return (c, t.str("status"))
                }
                if !todos.isEmpty {
                    plan = todos.enumerated().map { i, t in PlanStep(id: "todo_\(i + 1)", title: t.0, status: status(t.1), createdAt: at, updatedAt: at) }
                }
            case "TaskCreate":
                guard let subject = input["subject"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !subject.isEmpty,
                      let id = taskId(r.output) else { continue }
                let note = firstLine(input["description"]?.string ?? "")
                plan = (plan ?? []) + [PlanStep(id: "task_\(id)", title: subject, status: .pending, note: note.isEmpty ? nil : note, createdAt: at, updatedAt: at)]
            case "TaskUpdate":
                guard var steps = plan else { continue }
                let id = "task_\(taskRef(input["taskId"]))"
                if input["status"]?.string == "deleted" { plan = steps.filter { $0.id != id }; continue }
                for i in steps.indices where steps[i].id == id {
                    if let s = input["status"]?.string { steps[i].status = status(s) }
                    if let t = input["subject"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { steps[i].title = t }
                    steps[i].updatedAt = at
                }
                plan = steps
            default: continue
            }
        }
        return plan?.isEmpty == false ? plan : nil
    }

    private static func taskRef(_ v: JSONValue?) -> String {
        (v?.string ?? v?.int64.map(String.init) ?? "").trimmingCharacters(in: .whitespaces)
    }

    /// A Claude Agent chat's plan when Claude Code wrote none: the work loop of
    /// the latest request (send, explore, build, verify, ship), read from its tool calls.
    public static func activityPlan(_ messages: [ChatMessage], working: Bool) -> [PlanStep]? {
        guard let start = messages.lastIndex(where: { $0.role == "user" }) else { return nil }
        let request = messages[start]
        let after = messages[(start + 1)...]
        var counts: [PlanStep.Kind: Int] = [:]
        var latest: PlanStep.Kind?
        var updatedAt = request.createdAt ?? 0
        for m in after {
            for call in m.toolCalls {
                guard let p = phase(of: call) else { continue }
                counts[p, default: 0] += 1
                latest = p
                updatedAt = m.createdAt ?? updatedAt
            }
        }
        if latest == nil && !working { return nil }
        let heard = after.contains { $0.role == "assistant" }
        let at = latest.flatMap { l in phases.firstIndex { $0.kind == l } } ?? -1
        let asked = request.createdAt ?? 0
        let note = String(firstLine(request.content).prefix(160))
        var steps = [PlanStep(id: sent, title: "Send the request to Claude Code", status: heard ? .done : .active,
                              note: note.isEmpty ? nil : note, createdAt: asked, updatedAt: asked)]
        for (i, p) in phases.enumerated() {
            let n = counts[p.kind] ?? 0
            let status: PlanStep.Status
            if working && p.kind == latest { status = .active }
            else if n > 0 { status = .done }
            // Claude Code has answered but not reached for a tool yet: it is working out where to look.
            else if working && latest == nil && heard && i == 0 { status = .active }
            else if working && i > at { status = .pending }
            else { continue }
            let note = n > 0 ? p.note(n) : ""
            steps.append(PlanStep(id: phasePrefix + p.kind.rawValue, title: p.title, status: status, kind: p.kind,
                                  note: note.isEmpty ? nil : note, createdAt: asked, updatedAt: updatedAt))
        }
        return steps
    }

    // MARK: Chips placed on steps

    private static let projectPatterns: [(String, @Sendable ([String]) -> String)] = [
        (#"^https://linear\.app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)"#, { $0[1].uppercased() }),
        (#"^https://[a-z0-9-]+\.atlassian\.net/browse/([A-Za-z][A-Za-z0-9]*-\d+)"#, { $0[1].uppercased() }),
        (#"^https://github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)(?:[/?#]|$)"#, { "\($0[1])#\($0[2])" }),
        (#"^https://trello\.com/c/[A-Za-z0-9]+"#, { _ in "Trello card" }),
        (#"^https://app\.asana\.com/\d+/\d+/\d+"#, { _ in "Asana task" }),
        (#"^https://app\.clickup\.com/t/[\w-]+"#, { _ in "ClickUp task" }),
        (#"^https://(?:app\.)?todoist\.com/(?:app/)?(?:task|showTask)"#, { _ in "Todoist task" }),
    ]

    private static func matches(_ pattern: String, _ text: String, options: NSRegularExpression.Options = []) -> [[String]] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
        }
    }

    /// Task links (Linear, Jira, GitHub issues, Trello, Asana, ClickUp, Todoist) in a message's text.
    public static func projectLinks(_ text: String) -> [ProjectLink] {
        var found: [ProjectLink] = []
        for raw in matches(#"https://[^\s<>()\[\]"'`]+"#, text).map({ $0[0] }) {
            let url = raw.replacingOccurrences(of: #"[.,;:!?]+$"#, with: "", options: .regularExpression)
            for (pattern, label) in projectPatterns {
                guard let m = matches(pattern, url, options: .caseInsensitive).first else { continue }
                if !found.contains(where: { $0.url == url }) { found.append(ProjectLink(url: url, label: label(m))) }
                break
            }
        }
        return found
    }

    /// GitHub pull request URLs in a tool's output.
    public static func prUrls(_ text: String) -> [String] {
        var out: [String] = []
        for m in matches(#"https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+"#, text) where !out.contains(m[0]) { out.append(m[0]) }
        return out
    }

    /// The steps an `update_plan` call leaves, replayed only far enough to know
    /// which titles exist and which is active (`applyPlanUpdate`).
    static func replay(_ current: [PlanStep]?, _ input: [String: JSONValue]) -> [PlanStep]? {
        let raw = input["steps"]?.array ?? []
        if raw.isEmpty { return nil }
        let hadPlan = !(current ?? []).isEmpty
        let replace = input["replace"]?.bool == true || !hadPlan
        var next = (current ?? []).filter { !replace || $0.squeezed }
        for r in raw {
            let title = String((r.str("title") ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(160))
            let id = r.str("id")?.trimmingCharacters(in: .whitespaces) ?? ""
            let status = r.str("status").flatMap(PlanStep.Status.init(rawValue:))
            var at = id.isEmpty ? nil : next.firstIndex { $0.id == id }
            if replace, let i = at, !title.isEmpty, next[i].title.lowercased() != title.lowercased() { at = nil }
            if at == nil, !title.isEmpty { at = next.firstIndex { $0.title.lowercased() == title.lowercased() } }
            if let i = at {
                let was = next[i].status
                if !title.isEmpty { next[i].title = title }
                if let status, !(replace && (was == .done || was == .skipped)) { next[i].status = status }
            } else if !title.isEmpty {
                next.append(PlanStep(id: !id.isEmpty && !next.contains { $0.id == id } ? id : "step_\(next.count + 1)", title: title, status: status ?? .pending))
            }
        }
        return next.isEmpty ? nil : next
    }

    /// What each step produced, worked out from the transcript as the desktop
    /// does: plan calls are replayed in order, and a PR the agent opened belongs
    /// to the step active then (matched to the live plan by title). Task links
    /// and sub-agents follow the same clock; anything before the first step goes
    /// on the first step. `prs` are the chat's own PRs (`pr:sessionList`): only
    /// those count, as the desktop counts only PRs the agent created.
    public static func links(_ messages: [ChatMessage], plan: [PlanStep], prs: Set<String>,
                             children: [SessionSummary] = []) -> [String: PlanStepLinks] {
        var links: [String: PlanStepLinks] = [:]
        guard let first = plan.first else { return links }
        var byTitle: [String: String] = [:]
        for step in plan where byTitle[step.title.trimmingCharacters(in: .whitespaces).lowercased()] == nil {
            byTitle[step.title.trimmingCharacters(in: .whitespaces).lowercased()] = step.id
        }
        let ids = Set(plan.map(\.id))
        var replayed: [PlanStep]?
        var active: String?
        var timeline: [(at: Int64, step: String?)] = []
        func work(_ title: String?, _ at: Int64) {
            active = title.flatMap { byTitle[$0.trimmingCharacters(in: .whitespaces).lowercased()] }
            timeline.append((at, active))
        }
        var creating: [String: String] = [:]
        var tasks: [String: String] = [:]
        let phased = ids.contains(sent)
        let lastAsk = phased ? messages.lastIndex { $0.role == "user" } ?? -1 : -1
        for (index, message) in messages.enumerated() {
            let at = message.createdAt ?? 0
            if phased && index == lastAsk { active = sent; timeline.append((at, active)) }
            if let r = message.toolResult, !r.isError, let subject = creating[r.toolCallId], let id = taskId(r.output) { tasks[id] = subject }
            if message.role == "user" || message.role == "assistant" {
                for link in projectLinks(message.content) where !links.values.contains(where: { $0.projects.contains(link) }) {
                    links[active ?? first.id, default: PlanStepLinks()].projects.append(link)
                }
            }
            for call in message.toolCalls {
                if phased && index > lastAsk, let p = phase(of: call), ids.contains(phasePrefix + p.rawValue) {
                    active = phasePrefix + p.rawValue
                    timeline.append((at, active))
                    continue
                }
                switch call.name {
                case "TodoWrite":
                    work(call.input["todos"]?.array?.first { $0.str("status") == "in_progress" }?.str("content"), at)
                case "TaskCreate":
                    if let s = call.input["subject"]?.string { creating[call.id] = s }
                case "TaskUpdate":
                    if call.input["status"]?.string == "in_progress" { work(tasks[taskRef(call.input["taskId"])], at) }
                case "update_plan":
                    guard let next = replay(replayed, call.input) else { continue }
                    replayed = next
                    // With parallel active steps, the latest one in the plan is the one being worked.
                    work(next.last { $0.status == .active }?.title, at)
                default: continue
                }
            }
            if let active, let output = message.toolResult?.output {
                for url in prUrls(output) where prs.contains(url) && links[active]?.prs.contains(url) != true {
                    links[active, default: PlanStepLinks()].prs.append(url)
                }
            }
        }
        for child in children.sorted(by: { ($0.createdAt ?? $0.updatedAt) < ($1.createdAt ?? $1.updatedAt) }) {
            let born = child.createdAt ?? child.updatedAt
            // The step being worked when it started, or the last one worked before then.
            let step = timeline.last { $0.at <= born && $0.step != nil }?.step ?? first.id
            links[step, default: PlanStepLinks()].subagents.append(child.id)
        }
        return links.filter { !$0.value.isEmpty }
    }
}
