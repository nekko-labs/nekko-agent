import Foundation
import NekkoProtocol
import Observation

/// A pull request (a merge request on GitLab) from the git provider connected
/// on this iPhone (decision 0055).
public struct PhonePullRequest: Equatable, Sendable, Identifiable {
    /// Why it is in the list.
    public enum Role: String, Sendable, CaseIterable { case reviewRequested, authored, assigned, project }
    public enum Review: String, Sendable { case approved, changesRequested, reviewRequired }

    public let url: String
    /// `owner/name` (GitLab: `group/subgroup/name`).
    public let repo: String
    public let number: Int
    public let title: String
    public var author: String?
    public var isDraft = false
    public var updatedAt: Int64?
    /// The branch it brings in, and the one it merges into.
    public var head: String?
    public var base: String?
    public var checks: PullRequest.Checks = .none
    public var review: Review?
    public var roles: Set<Role> = []
    public var id: String { url }

    public init(url: String, repo: String, number: Int, title: String) {
        self.url = url
        self.repo = repo
        self.number = number
        self.title = title
    }

    /// The repository's own name, which is what a project folder is usually called.
    public var repoName: String { repo.split(separator: "/").last.map(String.init) ?? repo }
}

/// A repository the user can see on the git provider, for Projects.
public struct PhoneRepo: Codable, Equatable, Sendable, Identifiable, Hashable {
    /// `owner/name`.
    public let fullName: String
    public var id: String { fullName }
    public var name: String { fullName.split(separator: "/").last.map(String.init) ?? fullName }
    public init(_ fullName: String) { self.fullName = fullName }
}

/// How each git provider is asked for pull requests, and how its answers read.
public enum PullRequestsAPI {
    /// GitHub's GraphQL address for a REST API address (`https://api.github.com`, or `https://host/api/v3` on Enterprise).
    public static func githubGraphQL(_ api: String) -> String {
        api.hasSuffix("/api/v3") ? String(api.dropLast(2)) + "graphql" : api + "/graphql"
    }

    static let fields = """
    fragment pr on PullRequest { number title url isDraft updatedAt headRefName baseRefName reviewDecision \
    author { login } repository { nameWithOwner } \
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    """

    static func search(_ alias: String, _ q: String, first: Int = 40) -> String {
        "\(alias): search(query: \(JSONValue.string(q + " is:pr is:open archived:false sort:updated-desc").serialized()), type: ISSUE, first: \(first)) { nodes { ...pr } }"
    }

    /// GitHub's search takes about 256 characters, so a long list of repos is split across searches.
    public static func repoQueries(_ repos: [String], limit: Int = 200) -> [String] {
        var out: [String] = []
        var cur = ""
        for r in repos {
            let term = "repo:\(r)"
            if !cur.isEmpty && cur.count + 1 + term.count > limit {
                out.append(cur)
                cur = ""
            }
            cur += cur.isEmpty ? term : " " + term
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    // MARK: Requests

    public static func mine(_ c: PhoneConnector, token: String) -> [PhoneRequest] {
        let h = PhoneConnectors.headers(c, token: token)
        switch c.kind {
        case "github":
            let q = "query { \(search("authored", "author:@me")) \(search("reviewRequested", "review-requested:@me")) \(search("assigned", "assignee:@me")) }\n\(fields)"
            return [PhoneRequest(url: githubGraphQL(c.settings["api"] ?? "https://api.github.com"), headers: h, body: ["query": .string(q)])]
        case "gitlab":
            let base = "\(c.settings["site"] ?? "https://gitlab.com")/api/v4/merge_requests?state=opened&per_page=40"
            var out = [PhoneRequest(method: "GET", url: "\(base)&scope=created_by_me", headers: h),
                       PhoneRequest(method: "GET", url: "\(base)&scope=assigned_to_me", headers: h)]
            if let me = c.userId { out.append(PhoneRequest(method: "GET", url: "\(base)&scope=all&reviewer_username=\(PhoneConnectors.query(me))", headers: h)) }
            return out
        case "bitbucket":
            guard let me = c.userId else { return [] }
            return [PhoneRequest(method: "GET", url: "https://api.bitbucket.org/2.0/pullrequests/\(PhoneConnectors.query(me))?state=OPEN&pagelen=50", headers: h)]
        default: return []
        }
    }

    /// The repositories the user can see, most recently active first.
    public static func repos(_ c: PhoneConnector, token: String) -> PhoneRequest? {
        let h = PhoneConnectors.headers(c, token: token)
        switch c.kind {
        case "github": return PhoneRequest(method: "GET", url: "\(c.settings["api"] ?? "https://api.github.com")/user/repos?per_page=100&sort=pushed", headers: h)
        case "gitlab":
            return PhoneRequest(method: "GET", url: "\(c.settings["site"] ?? "https://gitlab.com")/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at", headers: h)
        case "bitbucket": return PhoneRequest(method: "GET", url: "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on", headers: h)
        default: return nil
        }
    }

    /// The open pull requests of these repositories.
    public static func projects(_ c: PhoneConnector, token: String, repos: [String]) -> [PhoneRequest] {
        guard !repos.isEmpty else { return [] }
        let h = PhoneConnectors.headers(c, token: token)
        switch c.kind {
        case "github":
            let searches = repoQueries(repos).enumerated().map { search("p\($0.offset)", $0.element, first: 50) }.joined(separator: " ")
            return [PhoneRequest(url: githubGraphQL(c.settings["api"] ?? "https://api.github.com"), headers: h, body: ["query": .string("query { \(searches) }\n\(fields)")])]
        case "gitlab":
            let site = c.settings["site"] ?? "https://gitlab.com"
            return repos.map { PhoneRequest(method: "GET", url: "\(site)/api/v4/projects/\(PhoneConnectors.query($0))/merge_requests?state=opened&per_page=30", headers: h) }
        case "bitbucket":
            return repos.map { PhoneRequest(method: "GET", url: "https://api.bitbucket.org/2.0/repositories/\($0)/pullrequests?state=OPEN&pagelen=30", headers: h) }
        default: return []
        }
    }

    // MARK: Answers

    /// Pull requests in an answer, each with the role its search stands for
    /// (GitHub's aliases name it; GitLab's and Bitbucket's come from the request).
    public static func parse(kind: String, body: Data, role: PhonePullRequest.Role) -> [PhonePullRequest] {
        guard let v = try? JSONValue.parse(body) else { return [] }
        switch kind {
        case "github":
            var out: [PhonePullRequest] = []
            for (alias, result) in v["data"]?.object ?? [:] {
                let r = PhonePullRequest.Role(rawValue: alias) ?? .project
                out += (result["nodes"]?.array ?? []).compactMap { github($0, role: r) }
            }
            return out
        case "gitlab": return (v.array ?? []).compactMap { gitlab($0, role: role) }
        case "bitbucket": return (v["values"]?.array ?? []).compactMap { bitbucket($0, role: role) }
        default: return []
        }
    }

    public static func parseRepos(kind: String, body: Data) -> [PhoneRepo] {
        guard let v = try? JSONValue.parse(body) else { return [] }
        switch kind {
        case "github": return (v.array ?? []).compactMap { $0.str("full_name").map(PhoneRepo.init) }
        case "gitlab": return (v.array ?? []).compactMap { $0.str("path_with_namespace").map(PhoneRepo.init) }
        case "bitbucket": return (v["values"]?.array ?? []).compactMap { $0.str("full_name").map(PhoneRepo.init) }
        default: return []
        }
    }

    /// GraphQL answers a 200 with `errors` when a search is refused.
    public static func graphQLError(_ body: Data) -> String? {
        guard let v = try? JSONValue.parse(body), v["data"]?.object == nil || v["data"]?.isNull == true else { return nil }
        return v["errors"]?.array?.first?.str("message")
    }

    static func github(_ n: JSONValue, role: PhonePullRequest.Role) -> PhonePullRequest? {
        guard let url = n.str("url"), let num = n.long("number"), let repo = n["repository"]?.str("nameWithOwner") else { return nil }
        var p = PhonePullRequest(url: url, repo: repo, number: Int(num), title: n.str("title") ?? "")
        p.author = n["author"]?.str("login")
        p.isDraft = n.flag("isDraft")
        p.updatedAt = n.str("updatedAt").flatMap(date)
        p.head = n.str("headRefName")
        p.base = n.str("baseRefName")
        switch n["commits"]?["nodes"]?.array?.first?["commit"]?["statusCheckRollup"]?.str("state") {
        case "SUCCESS": p.checks = .passing
        case "FAILURE", "ERROR": p.checks = .failing
        case "PENDING", "EXPECTED": p.checks = .pending
        default: p.checks = .none
        }
        switch n.str("reviewDecision") {
        case "APPROVED": p.review = .approved
        case "CHANGES_REQUESTED": p.review = .changesRequested
        case "REVIEW_REQUIRED": p.review = .reviewRequired
        default: break
        }
        p.roles = [role]
        return p
    }

    static func gitlab(_ m: JSONValue, role: PhonePullRequest.Role) -> PhonePullRequest? {
        guard let url = m.str("web_url"), let iid = m.long("iid") else { return nil }
        let full = m["references"]?.str("full") ?? ""
        let repo = full.split(separator: "!").first.map(String.init) ?? ""
        var p = PhonePullRequest(url: url, repo: repo.isEmpty ? url : repo, number: Int(iid), title: m.str("title") ?? "")
        p.author = m["author"]?.str("username")
        p.isDraft = m.flag("draft") || m.flag("work_in_progress")
        p.updatedAt = m.str("updated_at").flatMap(date)
        p.head = m.str("source_branch")
        p.base = m.str("target_branch")
        if m.str("detailed_merge_status") == "ci_must_pass" { p.checks = .failing }
        if m.str("detailed_merge_status") == "ci_still_running" { p.checks = .pending }
        p.roles = [role]
        return p
    }

    static func bitbucket(_ b: JSONValue, role: PhonePullRequest.Role) -> PhonePullRequest? {
        guard let url = b["links"]?["html"]?.str("href"), let id = b.long("id") else { return nil }
        let repo = b["destination"]?["repository"]?.str("full_name") ?? ""
        var p = PhonePullRequest(url: url, repo: repo, number: Int(id), title: b.str("title") ?? "")
        p.author = b["author"]?.str("nickname") ?? b["author"]?.str("display_name")
        p.isDraft = b.flag("draft")
        p.updatedAt = b.str("updated_on").flatMap(date)
        p.head = b["source"]?["branch"]?.str("name")
        p.base = b["destination"]?["branch"]?.str("name")
        p.roles = [role]
        return p
    }

    /// An ISO 8601 time, with or without fractions of a second, in epoch milliseconds.
    static func date(_ s: String) -> Int64? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        let plain = s.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return f.date(from: plain).map { Int64($0.timeIntervalSince1970 * 1000) }
    }

    /// One list from several answers: each pull request once, with every role it came under, newest first.
    public static func merge(_ lists: [[PhonePullRequest]]) -> [PhonePullRequest] {
        var byURL: [String: PhonePullRequest] = [:]
        var order: [String] = []
        for p in lists.joined() {
            if var seen = byURL[p.url] {
                seen.roles.formUnion(p.roles)
                if seen.checks == .none { seen.checks = p.checks }
                byURL[p.url] = seen
            } else {
                byURL[p.url] = p
                order.append(p.url)
            }
        }
        return order.compactMap { byURL[$0] }.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }
}

// MARK: Starting a chat about a pull request

/// The one-tap prompts on a pull request. Each opens New chat with the words
/// filled in; nothing is sent until Start.
public enum PullRequestPrompt: String, CaseIterable, Sendable, Identifiable {
    case review, fixChecks, addressComments, summarize, update, ask
    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .review: return String(localized: "Review it")
        case .fixChecks: return String(localized: "Fix the failing checks")
        case .addressComments: return String(localized: "Address the review comments")
        case .summarize: return String(localized: "Summarize it")
        case .update: return String(localized: "Update from the base branch")
        case .ask: return String(localized: "Ask about it")
        }
    }

    public var systemImage: String {
        switch self {
        case .review: return "eye"
        case .fixChecks: return "wrench.and.screwdriver"
        case .addressComments: return "text.bubble"
        case .summarize: return "doc.plaintext"
        case .update: return "arrow.triangle.merge"
        case .ask: return "questionmark.bubble"
        }
    }

    /// Worth offering for this pull request (Fix the failing checks only when they fail).
    public func fits(_ pr: PhonePullRequest) -> Bool {
        switch self {
        case .fixChecks: return pr.checks == .failing
        case .addressComments: return pr.review == .changesRequested || pr.roles.contains(.authored)
        default: return true
        }
    }

    public func text(for pr: PhonePullRequest) -> String {
        let head = pr.head.map { "`\($0)`" } ?? "its branch"
        let base = pr.base.map { "`\($0)`" } ?? "the base branch"
        let which = "pull request \(pr.url) (\(pr.repo) #\(pr.number): \(pr.title))"
        switch self {
        case .review:
            return "Review \(which). Fetch \(head) and read its diff against \(base). Give me a prioritized list of real problems: bugs first, then risks, then cleanups, each with the file and line. Don’t change anything yet."
        case .fixChecks:
            return "The checks on \(which) are failing. Check out \(head), find out why from the failing runs, fix it, run the tests that cover it, and push the fix to the same branch."
        case .addressComments:
            return "Read the review comments on \(which). On \(head), make the changes they ask for, reply to each comment with what you did (or why not), and push."
        case .summarize:
            return "Summarize \(which): what it changes and why, how risky it is, and what a reviewer should look at closely."
        case .update:
            return "Bring \(which) up to date: on \(head), merge in the latest \(base), resolve any conflicts, run the tests, and push."
        case .ask:
            return "About \(which): "
        }
    }
}

/// Where a chat about a pull request runs: the paired computer with a project
/// folder named like the repository (the active computer first), else the active one.
public enum PullRequestPlace {
    public struct Match: Equatable, Sendable {
        public let computer: String
        /// The folder with the repository, when one was found.
        public let folder: String?
    }

    public static func find(repo: String, computers: [(id: String, folders: [WorkspaceFolder])], active: String?) -> Match? {
        let name = (repo.split(separator: "/").last.map(String.init) ?? repo).lowercased()
        func holds(_ f: WorkspaceFolder) -> Bool {
            if f.name.lowercased() == name { return true }
            let last = f.path?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0).lowercased() }
            return last == name
        }
        let ordered = computers.filter { $0.id == active } + computers.filter { $0.id != active }
        for c in ordered {
            if let f = c.folders.first(where: holds) { return Match(computer: c.id, folder: f.id) }
        }
        if let active, computers.contains(where: { $0.id == active }) { return Match(computer: active, folder: nil) }
        return computers.first.map { Match(computer: $0.id, folder: nil) }
    }

    /// The repositories the paired computers' folders hold, from the repositories the provider lists.
    public static func projectRepos(folders: [WorkspaceFolder], repos: [PhoneRepo]) -> [PhoneRepo] {
        var names = Set<String>()
        for f in folders {
            names.insert(f.name.lowercased())
            if let last = f.path?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last { names.insert(String(last).lowercased()) }
        }
        return repos.filter { names.contains($0.name.lowercased()) }
    }
}

extension ComputersStore {
    /// Get New chat ready for a prompt about a pull request: the computer that
    /// holds its repository becomes active, and New chat's draft gets the words
    /// and that folder, keeping its model and tools. Returns where it will run.
    @discardableResult
    public func stageChat(_ text: String, repo: String) -> PullRequestPlace.Match? {
        let places = computers.map { c in (id: c.id, folders: folders(on: c.id)) }
        guard let match = PullRequestPlace.find(repo: repo, computers: places, active: activeId) else { return nil }
        if match.computer != activeId { connect(match.computer) }
        var draft = drafts.draft(DraftStore.newChat)
        draft.text = text
        if let folder = match.folder { draft.workspaceId = folder }
        drafts.set(DraftStore.newChat, draft)
        return match
    }
}

// MARK: The screen's model

/// The Pull requests screen: the selected git provider's pull requests that
/// involve the user (Mine), and the open ones in the repositories the paired
/// computers' folders hold plus the ones pinned here (Projects).
@MainActor
@Observable
public final class PullRequestsModel {
    public enum Scope: String, Sendable, CaseIterable { case mine, projects }

    public private(set) var mine: [PhonePullRequest] = []
    public private(set) var projects: [PhonePullRequest] = []
    /// Every repository the provider lists for the user (for pinning).
    public private(set) var repos: [PhoneRepo] = []
    /// Projects' repositories: the folders' and the pinned ones.
    public private(set) var projectRepos: [PhoneRepo] = []
    public private(set) var pinned: [PhoneRepo] = []
    public private(set) var loading = false
    public private(set) var loaded: Set<Scope> = []
    public private(set) var error: String?

    private let connectors: ConnectorsModel
    private let files: OfflineFiles?
    /// The kind the lists are from: a change of provider starts them over.
    private var kind: String?

    static let pinsFile = "phone-pinned-repos"

    public init(connectors: ConnectorsModel, files: OfflineFiles?) {
        self.connectors = connectors
        self.files = files
        loadPins()
    }

    public var provider: PhoneConnector? { connectors.gitProvider }

    public func load(_ scope: Scope, folders: [WorkspaceFolder]) async {
        guard let c = provider, let token = connectors.token(c.kind) else {
            error = nil
            mine = []
            projects = []
            return
        }
        if kind != c.kind {
            kind = c.kind
            mine = []
            projects = []
            repos = []
            loaded = []
            loadPins()
        }
        loading = true
        defer { loading = false }
        do {
            switch scope {
            case .mine:
                mine = try await fetch(PullRequestsAPI.mine(c, token: token), c, role: .authored)
            case .projects:
                if repos.isEmpty, let r = PullRequestsAPI.repos(c, token: token) {
                    let (status, body) = try await connectors.http.send(r)
                    guard (200..<300).contains(status) else { throw ConnectError(message: PhoneConnectors.failure(label: c.label, status: status, body: body)) }
                    repos = PullRequestsAPI.parseRepos(kind: c.kind, body: body)
                }
                var list = PullRequestPlace.projectRepos(folders: folders, repos: repos)
                for p in pinned where !list.contains(p) { list.append(p) }
                projectRepos = list
                projects = try await fetch(PullRequestsAPI.projects(c, token: token, repos: list.map(\.fullName)), c, role: .project)
            }
            error = nil
            loaded.insert(scope)
        } catch {
            self.error = error.localizedDescription
            loaded.insert(scope)
        }
    }

    private func fetch(_ requests: [PhoneRequest], _ c: PhoneConnector, role: PhonePullRequest.Role) async throws -> [PhonePullRequest] {
        let http = connectors.http
        var lists: [[PhonePullRequest]] = []
        for (i, request) in requests.enumerated() {
            let (status, body) = try await http.send(request)
            guard (200..<300).contains(status) else { throw ConnectError(message: PhoneConnectors.failure(label: c.label, status: status, body: body)) }
            if c.kind == "github", let e = PullRequestsAPI.graphQLError(body) { throw ConnectError(message: "\(c.label): \(e)") }
            // GitLab's three lists are mine, assigned and to review, in that order.
            let gitlabRoles: [PhonePullRequest.Role] = [.authored, .assigned, .reviewRequested]
            let each = c.kind == "gitlab" && role != .project ? gitlabRoles[min(i, 2)] : role
            lists.append(PullRequestsAPI.parse(kind: c.kind, body: body, role: each))
        }
        return PullRequestsAPI.merge(lists)
    }

    public func pin(_ repo: PhoneRepo) {
        guard !pinned.contains(repo) else { return }
        pinned.append(repo)
        savePins()
    }

    public func unpin(_ repo: PhoneRepo) {
        pinned.removeAll { $0 == repo }
        projectRepos.removeAll { $0 == repo && !pinned.contains($0) }
        projects.removeAll { $0.repo == repo.fullName }
        savePins()
    }

    private func loadPins() {
        let all = PhoneChats.decode([String: [PhoneRepo]].self, files?.load(ConnectorsModel.place, Self.pinsFile)) ?? [:]
        pinned = provider.flatMap { all[$0.kind] } ?? []
    }

    private func savePins() {
        guard let files, let kind = provider?.kind else { return }
        var all = PhoneChats.decode([String: [PhoneRepo]].self, files.load(ConnectorsModel.place, Self.pinsFile)) ?? [:]
        all[kind] = pinned
        if let v = PhoneChats.encode(all) { files.save(ConnectorsModel.place, Self.pinsFile, v) }
    }
}
