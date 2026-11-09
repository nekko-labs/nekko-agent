import Foundation

/// What a chat row says under its title, as the desktop's agent card
/// (`WorkspaceCard.tsx`) says it: the provider's mark and the model ("Opus 5.5"),
/// how full the context window is while the chat is still in progress, and one
/// chip for its pull requests (the one that matters most, its state, and `+N`).
/// Ports of `shortModelName`, `guessContextWindow`, `fillTone`, `providerMarkKind`
/// and `primaryPr`, pure so both phones and the tests agree. Android: `ChatCard.kt`.
public enum ChatCard {
    // MARK: Model

    struct ClaudeId: Equatable { let family: String; let major: Int; let minor: Int }

    static func matches(_ s: String, _ pattern: String) -> Bool { s.range(of: pattern, options: .regularExpression) != nil }

    /// A Claude id as family and version, past a gateway's `vendor/` and Bedrock's `anthropic.` prefixes.
    static func parseClaude(_ id: String?) -> ClaudeId? {
        var s = (id ?? "").lowercased().trimmingCharacters(in: .whitespaces)
        if let slash = s.lastIndex(of: "/") { s = String(s[s.index(after: slash)...]) }
        if let at = s.range(of: "anthropic."), s[at.upperBound...].hasPrefix("claude-") { s = String(s[at.upperBound...]) }
        let ns = s as NSString
        let claudePattern = try! NSRegularExpression(pattern: #"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?"#)
        guard let m = claudePattern.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> String? { m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
        return ClaudeId(family: group(1) ?? "", major: group(2).flatMap { Int($0) } ?? 0, minor: group(3).flatMap { Int($0) } ?? 0)
    }

    /// The model as a card line: "Opus 5.5" for a Claude id, else the id without
    /// its vendor, `:latest` or date (`AgentRows.shortModelName`).
    public static func modelName(_ id: String) -> String {
        if let c = parseClaude(id) {
            let family = String(c.family.prefix(1)).uppercased() + String(c.family.dropFirst())
            return c.minor > 0 ? "\(family) \(c.major).\(c.minor)" : "\(family) \(c.major)"
        }
        return AgentRows.shortModelName(id)
    }

    // MARK: Provider

    /// The provider mark for a chat: an asset key (`anthropic`, `openai`, `google`,
    /// `openrouter`, `ollama`, `lmstudio`, `vllm`) or nil for none. The provider's
    /// kind decides when the phone knows it, as on the desktop; a custom endpoint
    /// gets no mark. Without the kind (a chat on a computer not in view), a model
    /// id that can only be one vendor's names it.
    public static func providerMark(kind: String?, modelId: String?) -> String? {
        if let kind, !kind.isEmpty {
            switch kind {
            // The phone's own Bedrock and Foundry providers serve only Claude.
            case "anthropic", "claude-code", "bedrock", "foundry": return "anthropic"
            case "openai", "chatgpt", "codex": return "openai"
            case "gemini", "vertex": return "google"
            case "openrouter": return "openrouter"
            case "ollama", "ollama-cloud": return "ollama"
            case "lmstudio": return "lmstudio"
            case "vllm": return "vllm"
            default: return nil
            }
        }
        let id = (modelId ?? "").lowercased()
        guard !id.isEmpty, !id.contains("/") else { return nil }
        if parseClaude(id) != nil || ["opus", "sonnet", "haiku"].contains(id) || id.hasPrefix("claude") { return "anthropic" }
        if id.hasPrefix("gpt-") || id.hasPrefix("chatgpt") || matches(id, #"^o[134](?:$|-)"#) { return "openai" }
        if id.hasPrefix("gemini") { return "google" }
        return nil
    }

    // MARK: Context

    /// The model's context window when the computer did not say: the desktop's `guessContextWindow`.
    public static func guessContextWindow(_ modelId: String?) -> Int64 {
        let id = (modelId ?? "").lowercased()
        if id.isEmpty { return 128_000 }
        if let c = parseClaude(id) {
            if c.family == "fable" || c.family == "mythos" { return 1_000_000 }
            if c.family == "haiku" { return c.major >= 5 ? 1_000_000 : 200_000 }
            return c.major > 4 || (c.major == 4 && c.minor >= 6) ? 1_000_000 : 200_000
        }
        if ["opus", "sonnet", "haiku"].contains(id) { return 1_000_000 }
        if id.contains("claude") { return 200_000 }
        if id.contains("gemini") { return 1_000_000 }
        if matches(id, #"(?:^|/)gpt-5\.6-(?:sol|terra|luna)(?:$|[-/])"#) { return 272_000 }
        if matches(id, #"(?:^|/)gpt-5(?:-(?:mini|nano|codex))?(?:$|-\d{4}-\d{2}-\d{2}$)"#) { return 400_000 }
        if id.contains("gpt-4.1") { return 1_047_576 }
        if matches(id, #"(?:^|/)o[34](?:$|[-/])"#) { return 200_000 }
        return 128_000
    }

    /// How full a window is, in the desktop's three hues: room (green), filling (amber), nearly full (red).
    public enum Fill: Sendable, Equatable { case room, filling, full }

    public static func fill(used: Int64, window: Int64) -> Fill {
        guard window > 0 else { return .room }
        let pct = Double(used) / Double(window) * 100
        return pct >= 85 ? .full : pct >= 60 ? .filling : .room
    }

    /// The gauge's words, `45k/1M`, and how full it is; nil when nothing is used yet.
    public struct Context: Equatable, Sendable {
        public let used: Int64
        public let window: Int64
        public let text: String
        public let fill: Fill
        public var percent: Int { window > 0 ? Int((Double(used) / Double(window) * 100).rounded()) : 0 }
    }

    public static func context(_ s: SessionSummary) -> Context? {
        guard let used = s.contextUsed ?? s.transcriptTokens, used > 0 else { return nil }
        let window = s.contextWindow ?? guessContextWindow(s.modelId)
        return Context(used: used, window: window, text: "\(compactTokens(used))/\(compactTokens(window))", fill: fill(used: used, window: window))
    }

    /// Context matters while the chat is in progress: running, waiting on you,
    /// stopped on an error, or idle with a watch armed. A finished or completed
    /// chat has no context pressure left, so its card leaves the gauge off.
    public static func showsContext(_ s: SessionSummary, activity: Activity?) -> Bool {
        !s.archived && (activity != nil || s.running || s.activeWatchCount > 0)
    }

    /// "4.5k" / "312k" / "1M": the desktop card's `compactTokens`.
    public static func compactTokens(_ n: Int64) -> String {
        func trim(_ s: String) -> String { s.hasSuffix(".0") ? String(s.dropLast(2)) : s }
        if n >= 1_000_000 { return trim(String(format: "%.1f", Double(n) / 1_000_000)) + "M" }
        if n >= 10_000 { return String(format: "%.0f", Double(n) / 1000) + "k" }
        if n >= 1000 { return String(format: "%.1f", Double(n) / 1000) + "k" }
        return String(n)
    }

    // MARK: Pull requests

    /// A PR's state as GitHub shows it: a draft is an open PR that is not ready.
    public enum PrStatus: String, Sendable, Equatable { case open, draft, merged, closed }

    public static func prStatus(_ pr: PullRequest) -> PrStatus {
        switch pr.state {
        case .merged: return .merged
        case .closed: return .closed
        case .open: return pr.isDraft ? .draft : .open
        }
    }

    static func rank(_ s: PrStatus) -> Int {
        switch s {
        case .open: return 0
        case .draft: return 1
        case .merged: return 2
        case .closed: return 3
        }
    }

    /// The repository a PR belongs to: its URL up to `/pull/` (or GitLab's `/-/merge_requests/`).
    static func repo(_ pr: PullRequest) -> String {
        for marker in ["/pull/", "/-/merge_requests/", "/pull-requests/"] {
            if let r = pr.url.range(of: marker) { return String(pr.url[..<r.lowerBound]) }
        }
        return pr.url
    }

    /// The PR a row's chip shows when a chat has several: still in flight over done
    /// (open, draft, merged, closed), then the newest. Numbers only order PRs within
    /// one repository; ties keep the given order.
    public static func primaryPr(_ prs: [PullRequest]) -> PullRequest? {
        var best: PullRequest?
        for pr in prs {
            guard let b = best else { best = pr; continue }
            let r = rank(prStatus(pr)) - rank(prStatus(b))
            if r < 0 || (r == 0 && pr.number > b.number && repo(pr) == repo(b)) { best = pr }
        }
        return best
    }
}
