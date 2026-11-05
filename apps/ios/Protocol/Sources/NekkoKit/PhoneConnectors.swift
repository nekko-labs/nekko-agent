import Foundation
import NekkoProtocol
import Observation

/// Services this iPhone connects to itself (decision 0052): a git provider for
/// the Pull requests screen, and the project-management tools the user works
/// in. As with the phone's own model providers (decision 0050), the token is
/// kept in this iPhone's Keychain and sent only to that service, over https.
/// A computer's connectors are its own: none of these is sent to a computer,
/// the relay or Nekko Cloud, and a phone still can't change a computer's.
public enum PhoneConnectors {
    public enum Category: String, Codable, Sendable { case git, tasks }

    /// A setting a kind asks for besides its token.
    public struct Field: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let placeholder: String
        /// The service's own address: checked as https, trailing slashes dropped.
        public var isURL = false
        /// Left empty, this is used.
        public var defaultValue: String?
    }

    public struct Kind: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let category: Category
        /// What the secret is called on this kind.
        public let tokenName: String
        /// A line under the form: where the token comes from.
        public let hint: String
        public var fields: [Field] = []
        /// Lists pull (or merge) requests on the Pull requests screen.
        public var listsPullRequests: Bool { category == .git }
    }

    /// In the order the Connectors page lists them. Ids match the desktop's connector kinds where they share one.
    public static let kinds: [Kind] = [
        Kind(id: "github", label: "GitHub", category: .git, tokenName: "Personal access token",
             hint: "A token from github.com → Settings → Developer settings. Fine-grained with read access to pull requests, or classic with repo.",
             fields: [Field(id: "api", label: "API address", placeholder: "https://api.github.com", isURL: true,
                            defaultValue: "https://api.github.com")]),
        Kind(id: "gitlab", label: "GitLab", category: .git, tokenName: "Personal access token",
             hint: "A token with read_api, from GitLab → Preferences → Access tokens. gitlab.com or your own instance.",
             fields: [Field(id: "site", label: "Instance", placeholder: "https://gitlab.com", isURL: true, defaultValue: "https://gitlab.com")]),
        Kind(id: "bitbucket", label: "Bitbucket", category: .git, tokenName: "API token",
             hint: "An Atlassian API token with Bitbucket read scopes, and the email of your Atlassian account.",
             fields: [Field(id: "email", label: "Email", placeholder: "you@example.com")]),
        Kind(id: "linear", label: "Linear", category: .tasks, tokenName: "API key",
             hint: "A personal API key from Linear → Settings → Security & access."),
        Kind(id: "jira", label: "Jira", category: .tasks, tokenName: "API token",
             hint: "An API token from id.atlassian.com → Security, your site, and the email you sign in with.",
             fields: [Field(id: "site", label: "Site", placeholder: "https://your-team.atlassian.net", isURL: true),
                      Field(id: "email", label: "Email", placeholder: "you@example.com")]),
        Kind(id: "floop", label: "Floop", category: .tasks, tokenName: "API token",
             hint: "Your team’s Floop server and an API token from it.",
             fields: [Field(id: "url", label: "Server", placeholder: "https://floop.example.com", isURL: true)]),
        Kind(id: "asana", label: "Asana", category: .tasks, tokenName: "Personal access token",
             hint: "A personal access token from Asana’s developer console."),
        Kind(id: "clickup", label: "ClickUp", category: .tasks, tokenName: "API token",
             hint: "Your personal API token from ClickUp → Settings → Apps."),
        Kind(id: "trello", label: "Trello", category: .tasks, tokenName: "Token",
             hint: "Your Trello API key and a token you generate from it at trello.com/power-ups/admin.",
             fields: [Field(id: "key", label: "API key", placeholder: "Trello API key")]),
        Kind(id: "todoist", label: "Todoist", category: .tasks, tokenName: "API token",
             hint: "Your API token from Todoist → Settings → Integrations → Developer."),
    ]

    public static func kind(_ id: String) -> Kind? { kinds.first { $0.id == id } }

    /// Where a connector's token is kept in the Keychain.
    public static func tokenName(_ kind: String) -> String { "phone-connector-token.\(kind)" }

    public enum Problem: Error, Equatable, LocalizedError {
        case token, unknownKind
        case missing(String)
        case url(String)
        public var errorDescription: String? {
            switch self {
            case .token: return String(localized: "Paste the token.")
            case .unknownKind: return String(localized: "This service can’t be connected on the iPhone.")
            case .missing(let what): return String(localized: "Fill in \(what).")
            case .url(let what): return String(localized: "\(what) must be a full https:// address.")
            }
        }
    }

    /// A connector as the Connect sheet made it, checked. The token is kept apart, in the Keychain.
    public static func make(kind kindId: String, token: String, settings: [String: String], at: Int64) throws -> PhoneConnector {
        guard let kind = kind(kindId) else { throw Problem.unknownKind }
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Problem.token }
        var out: [String: String] = [:]
        for f in kind.fields {
            var v = settings[f.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if v.isEmpty, let d = f.defaultValue { v = d }
            guard !v.isEmpty else { throw Problem.missing(f.label) }
            if f.isURL {
                while v.hasSuffix("/") { v.removeLast() }
                guard let u = URL(string: v), u.scheme == "https", let host = u.host, !host.isEmpty, !v.contains(" ") else {
                    throw Problem.url(f.label)
                }
            }
            out[f.id] = v
        }
        return PhoneConnector(kind: kind.id, settings: out, connectedAt: at)
    }

    // MARK: Requests

    static func basic(_ user: String, _ token: String) -> String {
        "Basic " + Data("\(user):\(token)".utf8).base64EncodedString()
    }

    static func query(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    /// The headers every call to this connector carries.
    public static func headers(_ c: PhoneConnector, token: String) -> [String: String] {
        switch c.kind {
        case "github":
            return ["Authorization": "Bearer \(token)", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"]
        case "gitlab": return ["PRIVATE-TOKEN": token, "Accept": "application/json"]
        case "bitbucket", "jira": return ["Authorization": basic(c.settings["email"] ?? "", token), "Accept": "application/json"]
        case "linear": return ["Authorization": token, "Content-Type": "application/json"]
        case "clickup": return ["Authorization": token, "Accept": "application/json"]
        case "trello": return ["Accept": "application/json"]
        default: return ["Authorization": "Bearer \(token)", "Accept": "application/json"]
        }
    }

    /// Connect's check: a real call that answers with who the token belongs to.
    public static func whoAmI(_ c: PhoneConnector, token: String) -> PhoneRequest {
        let h = headers(c, token: token)
        let s = c.settings
        switch c.kind {
        case "github": return PhoneRequest(method: "GET", url: "\(s["api"] ?? "https://api.github.com")/user", headers: h)
        case "gitlab": return PhoneRequest(method: "GET", url: "\(s["site"] ?? "https://gitlab.com")/api/v4/user", headers: h)
        case "bitbucket": return PhoneRequest(method: "GET", url: "https://api.bitbucket.org/2.0/user", headers: h)
        case "linear":
            return PhoneRequest(url: "https://api.linear.app/graphql", headers: h, body: ["query": "{ viewer { name email } }"])
        case "jira": return PhoneRequest(method: "GET", url: "\(s["site"] ?? "")/rest/api/3/myself", headers: h)
        case "floop": return PhoneRequest(method: "GET", url: "\(s["url"] ?? "")/api/v1/items?assignee=me&open=true&limit=1", headers: h)
        case "asana": return PhoneRequest(method: "GET", url: "https://app.asana.com/api/1.0/users/me", headers: h)
        case "clickup": return PhoneRequest(method: "GET", url: "https://api.clickup.com/api/v2/user", headers: h)
        case "trello":
            let auth = "key=\(query(s["key"] ?? ""))&token=\(query(token))"
            return PhoneRequest(method: "GET", url: "https://api.trello.com/1/members/me?fields=username,fullName&\(auth)", headers: h)
        default: return PhoneRequest(method: "GET", url: "https://api.todoist.com/api/v1/tasks?limit=1", headers: h)
        }
    }

    /// The account name in a `whoAmI` answer, or nil where the service doesn't say.
    public static func account(kind: String, body: Data) -> String? {
        guard let v = try? JSONValue.parse(body) else { return nil }
        let name: String? = switch kind {
        case "github", "gitlab": v.str("login") ?? v.str("username")
        case "bitbucket": v.str("username") ?? v.str("nickname") ?? v.str("display_name")
        case "linear": v["data"]?["viewer"]?.str("name") ?? v["data"]?["viewer"]?.str("email")
        case "jira": v.str("displayName") ?? v.str("emailAddress")
        case "asana": v["data"]?.str("name")
        case "clickup": v["user"]?.str("username") ?? v["user"]?.str("email")
        case "trello": v.str("username") ?? v.str("fullName")
        default: nil
        }
        return name.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// What a failed answer says, in the service's words where it has some.
    public static func failure(label: String, status: Int, body: Data) -> String {
        let v = try? JSONValue.parse(body)
        let found: [String?] = [
            v?.str("message"), v?.str("error_description"), v?["error"]?.str("message"), v?.str("error"),
            v?["errors"]?.array?.first?.str("message"), v?["errorMessages"]?.array?.first?.string,
        ]
        let message: String? = found.compactMap { $0 }.first
        let said = message.map { ": \($0)" } ?? ""
        switch status {
        case 401, 403: return String(localized: "\(label) turned the token down (\(status))\(said)")
        case 404: return String(localized: "\(label) doesn’t know that address (404)\(said)")
        case 429: return String(localized: "\(label) is rate limiting this token (429)\(said)")
        default: return String(localized: "\(label) answered \(status)\(said)")
        }
    }
}

/// A service this iPhone is connected to. Holds no secret: the token is in the Keychain.
public struct PhoneConnector: Codable, Equatable, Sendable, Identifiable {
    public let kind: String
    /// The kind's fields (address, email, Trello's key): never the token.
    public var settings: [String: String]
    public var connectedAt: Int64
    /// Who the token signed in as, when the service said.
    public var account: String?
    public var id: String { kind }

    public init(kind: String, settings: [String: String] = [:], connectedAt: Int64, account: String? = nil) {
        self.kind = kind
        self.settings = settings
        self.connectedAt = connectedAt
        self.account = account
    }

    public var label: String { PhoneConnectors.kind(kind)?.label ?? kind }
    public var category: PhoneConnectors.Category { PhoneConnectors.kind(kind)?.category ?? .tasks }
}

/// What this iPhone is connected to, kept beside its own providers (decision
/// 0052): the list in a file of its own, each token in the Keychain.
@MainActor
@Observable
public final class ConnectorsModel {
    public private(set) var connectors: [PhoneConnector] = []
    /// The git provider the Pull requests screen reads; the first connected one when unset.
    public private(set) var selectedGit: String?

    private let secrets: SecureStore
    private let files: OfflineFiles?
    let http: PhoneHTTP
    private let now: () -> Int64

    static let file = "phone-connectors"
    /// Its own folder, so forgetting the phone's chats leaves the connectors (and Forget everything takes both).
    static let place = "this-iphone-connectors"

    struct Saved: Codable {
        var connectors: [PhoneConnector]
        var selectedGit: String?
    }

    public init(secrets: SecureStore, files: OfflineFiles?, http: PhoneHTTP,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.secrets = secrets
        self.files = files
        self.http = http
        self.now = now
        if let saved = PhoneChats.decode(Saved.self, files?.load(Self.place, Self.file)) {
            connectors = saved.connectors.filter { PhoneConnectors.kind($0.kind) != nil }
            selectedGit = saved.selectedGit
        }
    }

    public func connector(_ kind: String) -> PhoneConnector? { connectors.first { $0.kind == kind } }
    public var git: [PhoneConnector] { connectors.filter { $0.category == .git } }
    public var tasks: [PhoneConnector] { connectors.filter { $0.category == .tasks } }

    /// The git provider in use: the one picked, else the first connected.
    public var gitProvider: PhoneConnector? {
        selectedGit.flatMap { id in git.first { $0.kind == id } } ?? git.first
    }

    public func token(_ kind: String) -> String? { secrets.get(PhoneConnectors.tokenName(kind)) }

    /// Connect, checking the token with a real call first: nothing is kept if the service turns it down.
    /// Connecting a kind already connected replaces it (a new token, or another account).
    public func connect(kind: String, token: String, settings: [String: String]) async throws -> PhoneConnector {
        var c = try PhoneConnectors.make(kind: kind, token: token, settings: settings, at: now())
        let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let (status, body) = try await http.send(PhoneConnectors.whoAmI(c, token: secret))
        guard (200..<300).contains(status) else {
            throw ConnectError(message: PhoneConnectors.failure(label: c.label, status: status, body: body))
        }
        // Linear answers 200 with errors for a bad key.
        if let first = (try? JSONValue.parse(body))?["errors"]?.array?.first {
            let said = first.str("message").map { ": \($0)" } ?? ""
            throw ConnectError(message: String(localized: "\(c.label) turned the token down\(said)"))
        }
        c.account = PhoneConnectors.account(kind: kind, body: body)
        secrets.set(PhoneConnectors.tokenName(kind), secret)
        connectors.removeAll { $0.kind == kind }
        connectors.append(c)
        save()
        return c
    }

    public func disconnect(_ kind: String) {
        secrets.set(PhoneConnectors.tokenName(kind), nil)
        connectors.removeAll { $0.kind == kind }
        if selectedGit == kind { selectedGit = nil }
        save()
    }

    public func selectGit(_ kind: String) {
        guard git.contains(where: { $0.kind == kind }) else { return }
        selectedGit = kind
        save()
    }

    /// Settings → Forget everything on this iPhone.
    public func forgetAll() {
        for c in connectors { secrets.set(PhoneConnectors.tokenName(c.kind), nil) }
        connectors = []
        selectedGit = nil
        files?.remove(Self.place)
    }

    private func save() {
        guard let files, let v = PhoneChats.encode(Saved(connectors: connectors, selectedGit: selectedGit)) else { return }
        files.save(Self.place, Self.file, v)
    }
}

public struct ConnectError: Error, LocalizedError, Equatable {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}
