import Foundation

// Git on a chat's folder from the phone (IO-33 FA-2), as the computer
// projects it for phones (packages/shared/src/phone-git.ts): status, diffs,
// history, branches, compare and PR checks to read; stage, commit, a
// model-written message, push, switch, abort a merge, open a PR and act on
// one as Change actions (signed, Face ID or the passcode).
//
// A phone always names the chat (`session:<chatId>`), never a folder: the
// computer refuses anything else. Paths are relative to the chat's folder.
// Commits carry the author's name, never their email; a secret-looking file
// is listed with `hidden` and no patch.

/// One git call from the phone: the channel and the exact arguments sent
/// (and, for a Change, signed).
public struct GitRequest: Equatable, Sendable {
    public let channel: String
    public let args: [JSONValue]

    public init(_ channel: String, _ args: [JSONValue]) {
        self.channel = channel
        self.args = args
    }

    /// Whether the computer treats it as a Change (`PHONE_CHANGE_CHANNELS`).
    public var isChange: Bool { Channels.gitChange.contains(channel) }

    /// The workspace a phone names: the chat's own checkout.
    public static func folder(_ chatId: String) -> JSONValue { .string("session:" + chatId) }

    public static func status(_ chat: String, refresh: Bool = false) -> GitRequest {
        GitRequest(Channels.workspaceGitStatus, [folder(chat), .bool(refresh)])
    }

    /// Unstaged changes with new files, or what is staged.
    public static func diff(_ chat: String, staged: Bool, path: String? = nil, base: String? = nil) -> GitRequest {
        var o: [String: JSONValue] = ["staged": .bool(staged)]
        if let path { o["path"] = .string(path) }
        if let base { o["base"] = .string(base) }
        return GitRequest(Channels.gitDiff, [folder(chat), .object(o)])
    }

    public static func log(_ chat: String, limit: Int = 50, skip: Int = 0, ref: String? = nil) -> GitRequest {
        var o: [String: JSONValue] = ["limit": .int(Int64(limit)), "skip": .int(Int64(skip))]
        if let ref { o["ref"] = .string(ref) }
        return GitRequest(Channels.gitLog, [folder(chat), .object(o)])
    }

    public static func show(_ chat: String, _ rev: String) -> GitRequest {
        GitRequest(Channels.gitShow, [folder(chat), .string(rev)])
    }

    public static func branches(_ chat: String) -> GitRequest { GitRequest(Channels.gitBranches, [folder(chat)]) }

    public static func compare(_ chat: String, base: String, head: String) -> GitRequest {
        GitRequest(Channels.gitCompare, [folder(chat), .string(base), .string(head)])
    }

    public static func stage(_ chat: String, _ paths: [String]) -> GitRequest {
        GitRequest(Channels.gitStage, [folder(chat), .array(paths.map { .string($0) })])
    }

    public static func unstage(_ chat: String, _ paths: [String]) -> GitRequest {
        GitRequest(Channels.gitUnstage, [folder(chat), .array(paths.map { .string($0) })])
    }

    public static func commit(_ chat: String, message: String) -> GitRequest {
        GitRequest(Channels.gitCommit, [folder(chat), ["message": .string(message)]])
    }

    /// A message for what is staged, written by the computer's model (spends its tokens).
    public static func commitMessage(_ chat: String) -> GitRequest { GitRequest(Channels.gitCommitMessage, [folder(chat)]) }

    /// Push the current branch; publishes it to its remote first if it has no upstream yet.
    public static func push(_ chat: String) -> GitRequest {
        GitRequest(Channels.gitPush, [folder(chat), ["setUpstream": true]])
    }

    public static func switchBranch(_ chat: String, _ name: String, create: Bool = false) -> GitRequest {
        GitRequest(Channels.gitSwitch, [folder(chat), .string(name), ["create": .bool(create)]])
    }

    public static func mergeAbort(_ chat: String) -> GitRequest { GitRequest(Channels.gitMergeAbort, [folder(chat)]) }

    public static func createPr(_ chat: String, title: String, body: String = "", base: String? = nil, draft: Bool = false) -> GitRequest {
        var o: [String: JSONValue] = ["title": .string(title), "draft": .bool(draft)]
        if !body.isEmpty { o["body"] = .string(body) }
        if let base, !base.isEmpty { o["base"] = .string(base) }
        return GitRequest(Channels.prCreate, [folder(chat), .object(o)])
    }

    public static func prChecks(_ url: String) -> GitRequest { GitRequest(Channels.prChecks, [.string(url)]) }
    public static func prDiff(_ url: String) -> GitRequest { GitRequest(Channels.prDiff, [.string(url)]) }

    public static func prAction(_ url: String, _ action: PrAction) -> GitRequest {
        GitRequest(Channels.prAction, [.string(url), .string(action.rawValue)])
    }
}

/// What a phone may do to a pull request (`PHONE_PR_ACTIONS`).
public enum PrAction: String, CaseIterable, Sendable {
    case approve, merge, close, reopen

    public var label: String {
        switch self {
        case .approve: "Approve"
        case .merge: "Merge"
        case .close: "Close"
        case .reopen: "Reopen"
        }
    }
}

/// A chat folder's git position (`workspace:gitStatus`).
public struct GitStatus: Equatable, Sendable {
    public let repo: Bool
    public let branch: String?
    /// Short sha of HEAD: all a detached HEAD has.
    public let head: String?
    public let dirtyCount: Int
    public let ahead: Int
    public let behind: Int
    /// The linked worktree's folder name, when the chat works in one.
    public let worktree: String?
    public let pr: PullRequest?

    public init(repo: Bool, branch: String? = nil, head: String? = nil, dirtyCount: Int = 0, ahead: Int = 0, behind: Int = 0,
                worktree: String? = nil, pr: PullRequest? = nil) {
        self.repo = repo
        self.branch = branch
        self.head = head
        self.dirtyCount = dirtyCount
        self.ahead = ahead
        self.behind = behind
        self.worktree = worktree
        self.pr = pr
    }

    /// `main`, or `detached at abc1234`.
    public var position: String { branch ?? head.map { "detached at \($0)" } ?? "no commits yet" }

    /// `2 to push · 1 to pull`, or nil when level with its upstream.
    public var drift: String? {
        let parts = [ahead > 0 ? "\(ahead) to push" : nil, behind > 0 ? "\(behind) to pull" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    public static func from(_ v: JSONValue?) -> GitStatus? {
        guard let v, v.object != nil else { return nil }
        return GitStatus(repo: v.flag("repo"), branch: v.str("branch"), head: v.str("head"), dirtyCount: Int(v.long("dirtyCount") ?? 0),
                         ahead: Int(v.long("ahead") ?? 0), behind: Int(v.long("behind") ?? 0), worktree: v["worktree"]?.str("name"),
                         pr: v["pr"].flatMap { PullRequest.list(.array([$0])).first })
    }
}

/// One file of a diff, a commit, a compare or a PR.
public struct GitFile: Equatable, Sendable, Identifiable {
    public enum Status: String, Sendable { case added, removed, modified, renamed, conflicted }
    public let path: String
    public let oldPath: String?
    public let status: Status
    public let additions: Int
    public let deletions: Int
    public let binary: Bool
    /// A new file git doesn't track yet.
    public let untracked: Bool
    /// The patch was cut (too long for a phone, or past the answer's size cap).
    public let truncated: Bool
    /// May hold secrets: listed, never shown on a phone.
    public let hidden: Bool
    public let hunks: [PhoneChanges.Hunk]
    public var id: String { path }

    public init(path: String, oldPath: String? = nil, status: Status = .modified, additions: Int = 0, deletions: Int = 0,
                binary: Bool = false, untracked: Bool = false, truncated: Bool = false, hidden: Bool = false, patch: String = "") {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.binary = binary
        self.untracked = untracked
        self.truncated = truncated
        self.hidden = hidden
        hunks = hidden ? [] : GitFile.hunks(patch)
    }

    /// The letter a status list shows.
    public var mark: String {
        if untracked { return "?" }
        switch status {
        case .added: return "A"
        case .removed: return "D"
        case .modified: return "M"
        case .renamed: return "R"
        case .conflicted: return "U"
        }
    }

    /// Unified-diff hunks from git's patch text (from the first `@@`), in the
    /// shape the Changes view draws. `\ No newline` notes are dropped.
    public static func hunks(_ patch: String) -> [PhoneChanges.Hunk] {
        var out: [PhoneChanges.Hunk] = []
        var start: (Int, Int)?
        var lines: [String] = []
        func flush() {
            if let (o, n) = start { out.append(PhoneChanges.Hunk(oldStart: o, newStart: n, raw: lines)) }
            lines = []
        }
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = line.hasSuffix("\r") ? String(line.dropLast()) : String(line)
            if line.hasPrefix("@@") {
                flush()
                start = header(line)
            } else if start != nil, let first = line.first, first == " " || first == "+" || first == "-" {
                lines.append(line)
            }
        }
        flush()
        return out
    }

    /// `@@ -12,3 +14,4 @@ fn x` → (12, 14).
    static func header(_ line: String) -> (Int, Int)? {
        let parts = line.split(separator: " ")
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func start(_ s: Substring) -> Int? { Int(s.dropFirst().split(separator: ",").first ?? "") }
        guard let o = start(parts[1]), let n = start(parts[2]) else { return nil }
        return (o, n)
    }

    public static func from(_ f: JSONValue) -> GitFile? {
        guard let path = f.str("path") else { return nil }
        return GitFile(path: path, oldPath: f.str("oldPath"), status: Status(rawValue: f.str("status") ?? "") ?? .modified,
                       additions: Int(f.long("additions") ?? 0), deletions: Int(f.long("deletions") ?? 0), binary: f.flag("binary"),
                       untracked: f.flag("untracked"), truncated: f.flag("truncated"), hidden: f.flag("hidden"), patch: f.str("patch") ?? "")
    }
}

/// A diff as a phone receives it (`git:diff`, `pr:diff`, a commit's files, a compare's).
public struct GitDiff: Equatable, Sendable {
    public let files: [GitFile]
    public let truncated: Bool
    /// Files past the phone's limit, not listed.
    public let omittedFiles: Int
    /// Listed files whose patch is withheld because they may hold secrets.
    public let hiddenFiles: Int

    public init(files: [GitFile] = [], truncated: Bool = false, omittedFiles: Int = 0, hiddenFiles: Int = 0) {
        self.files = files
        self.truncated = truncated
        self.omittedFiles = omittedFiles
        self.hiddenFiles = hiddenFiles
    }

    public var additions: Int { files.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }

    public static func from(_ v: JSONValue?) -> GitDiff {
        GitDiff(files: (v?["files"]?.array ?? []).compactMap(GitFile.from), truncated: v?.flag("truncated") ?? false,
                omittedFiles: Int(v?.long("omittedFiles") ?? 0), hiddenFiles: Int(v?.long("hiddenFiles") ?? 0))
    }
}

/// One commit: the author's name, never their email.
public struct GitCommit: Equatable, Sendable, Identifiable, Hashable {
    public let sha: String
    public let short: String
    public let parents: [String]
    public let author: String
    /// Author date, ISO 8601.
    public let date: String
    public let subject: String
    /// Only in a commit's detail (`git:show`).
    public let body: String?
    public var id: String { sha }

    public init(sha: String, short: String? = nil, parents: [String] = [], author: String = "", date: String = "", subject: String = "", body: String? = nil) {
        self.sha = sha
        self.short = short ?? String(sha.prefix(7))
        self.parents = parents
        self.author = author
        self.date = date
        self.subject = subject
        self.body = body
    }

    public var isMerge: Bool { parents.count > 1 }

    public var when: Date? {
        let f = ISO8601DateFormatter()
        return f.date(from: date)
    }

    public static func from(_ c: JSONValue) -> GitCommit? {
        guard let sha = c.str("sha") else { return nil }
        return GitCommit(sha: sha, short: c.str("short"), parents: c["parents"]?.array?.compactMap(\.string) ?? [],
                         author: c.str("author") ?? "", date: c.str("date") ?? "", subject: c.str("subject") ?? "", body: c.str("body"))
    }

    public static func list(_ v: JSONValue?) -> [GitCommit] { (v?.array ?? []).compactMap(from) }
}

/// A commit and its changes (`git:show`).
public struct GitCommitDetail: Equatable, Sendable {
    public let commit: GitCommit
    public let diff: GitDiff

    public static func from(_ v: JSONValue?) -> GitCommitDetail? {
        guard let c = v?["commit"].flatMap(GitCommit.from) else { return nil }
        return GitCommitDetail(commit: c, diff: GitDiff.from(v))
    }
}

public struct GitBranch: Equatable, Sendable, Identifiable, Hashable {
    /// `main` locally, `origin/main` for a remote one.
    public let name: String
    public let sha: String
    public let subject: String
    public let current: Bool
    public let upstream: String?
    public let ahead: Int
    public let behind: Int
    /// The upstream was deleted on the remote.
    public let gone: Bool
    public let remote: String?
    public var id: String { name }

    public init(name: String, sha: String = "", subject: String = "", current: Bool = false, upstream: String? = nil,
                ahead: Int = 0, behind: Int = 0, gone: Bool = false, remote: String? = nil) {
        self.name = name
        self.sha = sha
        self.subject = subject
        self.current = current
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.gone = gone
        self.remote = remote
    }

    /// The local name a remote branch switches to: `origin/feat` → `feat`.
    public var localName: String {
        guard let remote, name.hasPrefix(remote + "/") else { return name }
        return String(name.dropFirst(remote.count + 1))
    }

    static func from(_ b: JSONValue) -> GitBranch? {
        guard let name = b.str("name") else { return nil }
        return GitBranch(name: name, sha: b.str("sha") ?? "", subject: b.str("subject") ?? "", current: b.flag("current"),
                         upstream: b.str("upstream"), ahead: Int(b.long("ahead") ?? 0), behind: Int(b.long("behind") ?? 0),
                         gone: b.flag("gone"), remote: b.str("remote"))
    }
}

/// Local and remote branches (`git:branches`).
public struct GitBranches: Equatable, Sendable {
    public let current: String?
    public let detached: Bool
    public let defaultBranch: String?
    public let local: [GitBranch]
    public let remote: [GitBranch]
    public let omitted: Int

    public init(current: String? = nil, detached: Bool = false, defaultBranch: String? = nil, local: [GitBranch] = [], remote: [GitBranch] = [], omitted: Int = 0) {
        self.current = current
        self.detached = detached
        self.defaultBranch = defaultBranch
        self.local = local
        self.remote = remote
        self.omitted = omitted
    }

    /// Remote branches with no local branch of the same name: switching to one makes it.
    public var remoteOnly: [GitBranch] {
        let names = Set(local.map(\.name))
        return remote.filter { !names.contains($0.localName) && $0.localName != "HEAD" }
    }

    /// What compare starts from: the remote's default branch, else `main`.
    public var compareBase: String { defaultBranch ?? (local.contains { $0.name == "main" } ? "main" : local.first?.name ?? "main") }

    public static func from(_ v: JSONValue?) -> GitBranches {
        GitBranches(current: v?.str("current"), detached: v?.flag("detached") ?? false, defaultBranch: v?.str("defaultBranch"),
                    local: (v?["local"]?.array ?? []).compactMap(GitBranch.from), remote: (v?["remote"]?.array ?? []).compactMap(GitBranch.from),
                    omitted: Int((v?.long("omittedLocal") ?? 0) + (v?.long("omittedRemote") ?? 0)))
    }
}

/// How `head` differs from `base` (`git:compare`).
public struct GitCompare: Equatable, Sendable {
    public let base: String
    public let head: String
    public let ahead: Int
    public let behind: Int
    public let commits: [GitCommit]
    public let diff: GitDiff

    public static func from(_ v: JSONValue?) -> GitCompare? {
        guard let v, let base = v.str("base"), let head = v.str("head") else { return nil }
        return GitCompare(base: base, head: head, ahead: Int(v.long("ahead") ?? 0), behind: Int(v.long("behind") ?? 0),
                          commits: GitCommit.list(v["commits"]), diff: GitDiff.from(v))
    }
}

/// What a git change answers: `ok: false` carries git's own reason.
public struct GitResult: Equatable, Sendable {
    public let ok: Bool
    public let message: String
    public let branch: String?
    public let upstream: String?
    public let commit: GitCommit?
    /// A new pull request's address (`pr:create`).
    public let url: String?
    public let pr: PullRequest?

    public init(ok: Bool, message: String, branch: String? = nil, upstream: String? = nil, commit: GitCommit? = nil, url: String? = nil, pr: PullRequest? = nil) {
        self.ok = ok
        self.message = message
        self.branch = branch
        self.upstream = upstream
        self.commit = commit
        self.url = url
        self.pr = pr
    }

    public static func from(_ v: JSONValue?) -> GitResult {
        guard let v, v.object != nil else { return GitResult(ok: false, message: "Your computer didn’t answer.") }
        return GitResult(ok: v.flag("ok"), message: v.str("message") ?? "", branch: v.str("branch"), upstream: v.str("upstream"),
                         commit: v["commit"].flatMap(GitCommit.from), url: v.str("url"),
                         pr: v["pr"].flatMap { PullRequest.list(.array([$0])).first })
    }
}

/// A commit message the computer's model wrote for what is staged.
public struct GitCommitMessage: Equatable, Sendable {
    public let message: String
    /// The staged diff was cut before the model saw it.
    public let inputTruncated: Bool

    public static func from(_ v: JSONValue?) -> GitCommitMessage? {
        guard let m = v?.str("message"), !m.isEmpty else { return nil }
        return GitCommitMessage(message: m, inputTruncated: v?.flag("inputTruncated") ?? false)
    }
}

/// One check on a pull request's head commit.
public struct PrCheck: Equatable, Sendable, Identifiable {
    public enum State: String, Sendable { case pass, fail, pending, skipping, cancel }
    public let name: String
    public let state: State
    public let workflow: String?
    public let link: String?
    public let description: String?
    public var id: String { [workflow, name].compactMap { $0 }.joined(separator: "/") }

    public var label: String {
        switch state {
        case .pass: "Passed"
        case .fail: "Failed"
        case .pending: "Running"
        case .skipping: "Skipped"
        case .cancel: "Cancelled"
        }
    }
}

/// The checks on a pull request (`pr:checks`), failing first.
public struct PrCheckList: Equatable, Sendable {
    public let url: String
    public let rollup: PullRequest.Checks
    public let items: [PrCheck]
    public let omitted: Int

    public static func from(_ v: JSONValue?) -> PrCheckList? {
        guard let v, let url = v.str("url") else { return nil }
        let order: [PrCheck.State] = [.fail, .pending, .cancel, .pass, .skipping]
        let items: [PrCheck] = (v["items"]?.array ?? []).compactMap { c in
            guard let name = c.str("name") else { return nil }
            return PrCheck(name: name, state: PrCheck.State(rawValue: c.str("state") ?? "") ?? .pending, workflow: c.str("workflow"),
                           link: c.str("link"), description: c.str("description"))
        }
        let sorted = items.enumerated().sorted { a, b in
            let (x, y) = (order.firstIndex(of: a.element.state) ?? 9, order.firstIndex(of: b.element.state) ?? 9)
            return x == y ? a.offset < b.offset : x < y
        }.map(\.element)
        return PrCheckList(url: url, rollup: PullRequest.Checks(rawValue: v.str("checks") ?? "") ?? .none, items: sorted,
                           omitted: Int(v.long("omittedItems") ?? 0))
    }
}
