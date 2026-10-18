import Foundation

/// One transcript model for a computer chat: saved messages plus a live overlay
/// folded from `agent:event`s while a turn runs. A port of
/// `apps/mobile/src/lib/transcript.ts` / Android `Transcript.kt`; views render `Block`s only.
public enum ToolStatus: Sendable, Equatable { case running, waiting, ok, error }

public enum Block: Equatable, Sendable, Identifiable {
    case user(id: String, text: String, at: Int64?, images: Int)
    case assistant(id: String, text: String, reasoning: String?, streaming: Bool, interrupted: Bool)
    case tool(id: String, name: String, label: String, status: ToolStatus, output: String?)

    public var id: String {
        switch self {
        case .user(let id, _, _, _), .assistant(let id, _, _, _, _), .tool(let id, _, _, _, _): return id
        }
    }

    /// The same block under another id (the one a view already knows it by).
    public func withId(_ id: String) -> Block {
        switch self {
        case .user(_, let text, let at, let images): return .user(id: id, text: text, at: at, images: images)
        case .assistant(_, let text, let r, let s, let i): return .assistant(id: id, text: text, reasoning: r, streaming: s, interrupted: i)
        case .tool(_, let name, let label, let status, let output): return .tool(id: id, name: name, label: label, status: status, output: output)
        }
    }

    var isAssistant: Bool { if case .assistant = self { return true } else { return false } }
    var isUser: Bool { if case .user = self { return true } else { return false } }
}

/// What a running turn has produced so far, before the session is re-read.
public struct LiveTurn: Equatable, Sendable {
    public var running = false
    public var blocks: [Block] = []
    public var approval: Approval?
    public var question: AskRequest?
    public var error: String?
    /// Tokens/sec of the last reply, when the host reported usage.
    public var rate: Double?
    /// When the overlay started (for Live Activities' elapsed time).
    public var startedAt: Int64?

    public init(running: Bool = false, blocks: [Block] = [], approval: Approval? = nil, question: AskRequest? = nil,
                error: String? = nil, rate: Double? = nil, startedAt: Int64? = nil) {
        self.running = running
        self.blocks = blocks
        self.approval = approval
        self.question = question
        self.error = error
        self.rate = rate
        self.startedAt = startedAt
    }
}

public enum Transcript {
    /// Saved messages → blocks. Tool results attach to the call that asked for them.
    public static func fromMessages(_ messages: [ChatMessage]) -> [Block] {
        var out: [Block] = []
        var toolIndex: [String: Int] = [:]
        for m in messages {
            switch m.role {
            case "user":
                let text = m.skill.map { "/\($0.name) \($0.input)".trimmingCharacters(in: .whitespaces) } ?? m.content
                out.append(.user(id: m.id, text: text, at: m.createdAt, images: m.imageCount))
            case "assistant":
                let reasoning = m.reasoning.flatMap { $0.isEmpty ? nil : $0 }
                if !m.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(reasoning?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) {
                    out.append(.assistant(id: m.id, text: m.content, reasoning: reasoning, streaming: false, interrupted: m.interrupted))
                }
                for call in m.toolCalls {
                    toolIndex[call.id] = out.count
                    out.append(.tool(id: call.id, name: call.name, label: toolLabel(call), status: .ok, output: nil))
                }
            case "tool":
                guard let r = m.toolResult, let i = toolIndex[r.toolCallId],
                      case .tool(let id, let name, let label, _, _) = out[i] else { continue }
                out[i] = .tool(id: id, name: name, label: label, status: r.isError ? .error : .ok,
                               output: clip(r.output, full: r.outputChars, images: r.omittedImages))
            default:
                continue
            }
        }
        return out
    }

    /// Fold one agent event into the live turn. Pure.
    public static func apply(_ turn: LiveTurn, _ e: AgentEvent) -> LiveTurn {
        var t = turn
        switch e {
        case .text(_, let delta):
            return appendStream(t) { text, reasoning in (text + delta, reasoning) }
        case .reasoning(_, let delta):
            return appendStream(t) { text, reasoning in (text, (reasoning ?? "") + delta) }
        case .toolCall(_, let call):
            t.running = true
            t.blocks = settle(t.blocks) + [.tool(id: call.id, name: call.name, label: toolLabel(call), status: .running, output: nil)]
        case .approvalRequired(_, let approval):
            t.running = true
            t.approval = approval
            t.blocks = upsertTool(t.blocks, approval.call, .waiting)
        case .toolResult(_, let r):
            if t.approval?.call.id == r.toolCallId { t.approval = nil }
            t.blocks = t.blocks.map { b in
                if case .tool(let id, let name, let label, _, _) = b, id == r.toolCallId {
                    return .tool(id: id, name: name, label: label, status: r.isError ? .error : .ok, output: clip(r.output))
                }
                return b
            }
        case .question(_, let request):
            t.running = true
            t.question = request
        case .questionResolved(_, let callId):
            if t.question?.callId == callId { t.question = nil }
        case .usage(_, let tokens, let ms):
            if let ms, ms > 0, tokens > 0 { t.rate = Double(tokens) / Double(ms) * 1000 }
        case .retry:
            // The failed call's streamed text is regenerated: drop what came after the last non-reply block.
            let keep = (t.blocks.lastIndex { !$0.isAssistant } ?? -1) + 1
            t.blocks = Array(t.blocks.prefix(keep))
        case .done:
            t.running = false
            t.approval = nil
            t.question = nil
            t.blocks = settle(t.blocks)
        case .error(_, let message):
            t.running = false
            t.approval = nil
            t.question = nil
            t.blocks = settle(t.blocks)
            // A user stop arrives as an error; it isn't one from the user's side.
            let m = message.lowercased()
            t.error = (m == "stopped" || m == "aborted") ? nil : message
        case .sessionMeta, .other:
            break
        }
        return t
    }

    private static func appendStream(_ turn: LiveTurn, _ change: (String, String?) -> (String, String?)) -> LiveTurn {
        var t = turn
        if case .assistant(let id, let text, let reasoning, _, let interrupted)? = t.blocks.last {
            let (nt, nr) = change(text, reasoning)
            t.blocks[t.blocks.count - 1] = .assistant(id: id, text: nt, reasoning: nr, streaming: true, interrupted: interrupted)
        } else {
            let (nt, nr) = change("", nil)
            // Unique per turn (its start time), so a reply kept under its live id
            // after the turn (`carriedIds`) can't collide with the next turn's.
            t.blocks.append(.assistant(id: "live-\(t.startedAt ?? 0)-\(t.blocks.count)", text: nt, reasoning: nr, streaming: true, interrupted: false))
        }
        t.running = true
        return t
    }

    private static func settle(_ blocks: [Block]) -> [Block] {
        blocks.map { b in
            if case .assistant(let id, let text, let r, true, let i) = b { return .assistant(id: id, text: text, reasoning: r, streaming: false, interrupted: i) }
            return b
        }
    }

    private static func upsertTool(_ blocks: [Block], _ call: ToolCall, _ status: ToolStatus) -> [Block] {
        if blocks.contains(where: { if case .tool(let id, _, _, _, _) = $0 { return id == call.id } else { return false } }) {
            return blocks.map { b in
                if case .tool(let id, let name, let label, _, let output) = b, id == call.id {
                    return .tool(id: id, name: name, label: label, status: status, output: output)
                }
                return b
            }
        }
        return settle(blocks) + [.tool(id: call.id, name: call.name, label: toolLabel(call), status: status, output: nil)]
    }

    /// Saved transcript + live overlay without duplicates. Only this turn's
    /// saved blocks (after our prompt) count, so a reply or call id that
    /// repeats an earlier turn is never swallowed.
    public static func mergeLive(saved: [Block], live: [Block]) -> [Block] {
        if live.isEmpty { return saved }
        let prompt: String? = live.lazy.compactMap { if case .user(_, let text, _, _) = $0 { return text } else { return nil } }.first
        let lastUserAt = saved.lastIndex(where: \.isUser)
        var lastUserText: String?
        if let i = lastUserAt, case .user(_, let text, _, _) = saved[i] { lastUserText = text }
        func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let prompt, lastUserText.map(trim) != trim(prompt) { return saved + live }
        let headEnd = (lastUserAt ?? -1) + 1
        let head = Array(saved.prefix(headEnd))
        let turn = Array(saved.dropFirst(headEnd))
        var toolIds = Set<String>()
        var replies = Set<String>()
        for b in turn {
            if case .tool(let id, _, _, _, _) = b { toolIds.insert(id) }
            if case .assistant(_, let text, _, _, _) = b { replies.insert(trim(text)) }
        }
        var liveTools: [String: Block] = [:]
        for b in live { if case .tool(let id, _, _, _, _) = b { liveTools[id] = b } }
        let extra = live.filter { b in
            switch b {
            case .user: return false
            case .tool(let id, _, _, _, _): return !toolIds.contains(id)
            case .assistant(_, let text, _, _, _): return trim(text).isEmpty || !replies.contains(trim(text))
            }
        }
        let mergedTurn = turn.map { b -> Block in
            if case .tool(let id, _, _, _, _) = b, let l = liveTools[id] { return l }
            return b
        }
        return head + mergedTurn + extra
    }

    /// When a turn ends its live blocks (`pending-…`, `live-…`) are replaced by
    /// the saved ones, which have the computer's ids. A list keyed by id would
    /// rebuild those rows: an open "Thought" folds up and the scroll jumps. This
    /// maps each new saved block to the live block it replaces (same kind, same
    /// text, in order) so the view can keep the id it already has.
    public static func carriedIds(shown old: [Block], next new: [Block]) -> [String: String] {
        func key(_ b: Block) -> String? {
            switch b {
            case .user(_, let text, _, _): return "u:" + text.trimmingCharacters(in: .whitespacesAndNewlines)
            case .assistant(_, let text, _, _, _): return "a:" + text.trimmingCharacters(in: .whitespacesAndNewlines)
            case .tool: return nil // tool calls keep the computer's id throughout
            }
        }
        let newIds = Set(new.map(\.id))
        var waiting: [String: [String]] = [:]
        for b in old where !newIds.contains(b.id) && (b.id.hasPrefix("live-") || b.id.hasPrefix("pending-")) {
            if let k = key(b) { waiting[k, default: []].append(b.id) }
        }
        let oldIds = Set(old.map(\.id))
        var out: [String: String] = [:]
        for b in new where !oldIds.contains(b.id) {
            guard let k = key(b), var ids = waiting[k], !ids.isEmpty else { continue }
            out[b.id] = ids.removeFirst()
            waiting[k] = ids
        }
        return out
    }

    /// Short human label for a tool call: the file, command or query it acts on.
    public static func toolLabel(_ call: ToolCall) -> String {
        let keys = ["command", "path", "file_path", "pattern", "query", "url", "name", "prompt", "task"]
        let detail = keys.lazy.compactMap { call.input[$0]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        let verb = toolVerbs[call.name] ?? call.name.replacingOccurrences(of: "_", with: " ")
        if let detail { return "\(verb) \(oneLine(detail, 80))" }
        return verb
    }

    static let toolVerbs = [
        "read_file": "Read", "write_file": "Write", "edit_file": "Edit", "list_dir": "List",
        "glob": "Find", "grep": "Search", "bash": "Run", "web_fetch": "Fetch",
        "web_search": "Search the web for", "spawn_agent": "Delegate", "ask_user": "Ask",
    ]

    static func oneLine(_ s: String, _ max: Int) -> String {
        let flat = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return flat.count > max ? String(flat.prefix(max - 1)) + "…" : flat
    }

    /// At most `max` characters of a tool's output. `full` is the original
    /// length when the computer already cut it; `images` notes screenshots the
    /// phone did not receive.
    public static func clip(_ s: String, max: Int = 4000, full: Int? = nil, images: Int = 0) -> String {
        let total = Swift.max(full ?? s.count, s.count)
        let shown = s.count > max ? String(s.prefix(max)) : s
        var notes: [String] = []
        if total > shown.count { notes.append("… (\(total - shown.count) more characters, on the computer)") }
        if images > 0 { notes.append(images == 1 ? "1 image, on the computer" : "\(images) images, on the computer") }
        return notes.isEmpty ? shown : shown + "\n" + notes.joined(separator: "\n")
    }

    /// `clip`'s output split back into the output and its trailing notes.
    public static func splitNotes(_ s: String) -> (String, [String]) {
        let lines = s.components(separatedBy: "\n")
        var i = lines.count
        while i > 0, isNote(lines[i - 1]) { i -= 1 }
        if i == lines.count { return (s, []) }
        return (lines.prefix(i).joined(separator: "\n"), Array(lines.dropFirst(i)))
    }

    private static func isNote(_ line: String) -> Bool {
        if line.hasPrefix("… ("), line.hasSuffix(" more characters, on the computer)") {
            return Int(line.dropFirst(3).prefix { $0.isNumber }) != nil
        }
        return line == "1 image, on the computer" || (line.hasSuffix(" images, on the computer") && Int(line.prefix { $0.isNumber }) != nil)
    }
}

/// What the chat list shows next to a computer's chat.
public enum Activity: Sendable, Equatable { case running, needsYou }

public enum ActivityTracker {
    /// Track which chats are mid-run or waiting on the user, from the event stream.
    public static func next(_ activity: [String: Activity], _ e: AgentEvent) -> [String: Activity] {
        let next: Activity?
        switch e {
        case .approvalRequired, .question: next = .needsYou
        case .text, .reasoning, .toolCall, .toolResult, .questionResolved: next = .running
        case .done, .error: next = nil
        default: return activity
        }
        var out = activity
        out[e.sessionId] = next
        return out
    }
}
