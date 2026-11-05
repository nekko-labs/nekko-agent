import Foundation
import NekkoProtocol

/// This iPhone as a place chats run (decision 0050): a cloud model API called
/// straight from the phone, on the user's own key, kept in this iPhone's
/// Keychain and never sent to a computer, the relay or Nekko Cloud. The same
/// cloud providers the desktop connects to, less the ones that need a computer
/// (Claude Code, the ChatGPT sign-in, local model servers).
public enum PhoneProviders {
    /// The place's id in the chat list, beside the paired computers' ids.
    public static let computerId = "this-iphone"
    /// Every chat that runs on this iPhone has an id that starts so.
    public static let chatPrefix = "phone:"
    public static func isPhoneChat(_ id: String) -> Bool { id.hasPrefix(chatPrefix) }

    /// Which API a kind speaks.
    public enum Wire: String, Sendable { case anthropic, vertex, openai }

    public struct Kind: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let wire: Wire
        public let defaultUrl: String
        /// The address must be edited (Bedrock's region, Foundry's resource, Vertex's project).
        public let urlRequired: Bool
        /// What the secret is called on this kind.
        public let keyName: String
        /// The key may be left out (an OpenAI-compatible server without auth).
        public let keyOptional: Bool
        /// A line under the form: where the key and the address come from.
        public let hint: String
        /// The models this kind serves when it has no models list to read.
        public let catalog: [PhoneModel]
        /// It lists its own models (`GET /v1/models` or `/models`).
        public var listsModels: Bool { catalog.isEmpty }
    }

    static let claude: [PhoneModel] = [
        PhoneModel(id: "claude-opus-5-5", name: "Claude Opus 5.5"),
        PhoneModel(id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"),
        PhoneModel(id: "claude-fable-5-1", name: "Claude Fable 5.1"),
        PhoneModel(id: "claude-haiku-5-5", name: "Claude Haiku 5.5"),
        PhoneModel(id: "claude-opus-4-8", name: "Claude Opus 4.8"),
        PhoneModel(id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6"),
    ]

    /// In the order the Add sheet lists them. Ids match the desktop's provider kinds.
    public static let kinds: [Kind] = [
        Kind(id: "anthropic", label: "Claude API", wire: .anthropic, defaultUrl: "https://api.anthropic.com",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from console.anthropic.com.", catalog: []),
        Kind(id: "openai", label: "OpenAI", wire: .openai, defaultUrl: "https://api.openai.com/v1",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from platform.openai.com.", catalog: []),
        Kind(id: "openrouter", label: "OpenRouter", wire: .openai, defaultUrl: "https://openrouter.ai/api/v1",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from openrouter.ai: one key for many model makers.", catalog: []),
        Kind(id: "bedrock", label: "Claude in Amazon Bedrock", wire: .anthropic,
             defaultUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
             urlRequired: true, keyName: "Bedrock API key", keyOptional: false,
             hint: "A Bedrock API key. Put your region in the address.",
             catalog: claude.map { PhoneModel(id: "anthropic.\($0.id)", name: $0.name) }),
        Kind(id: "foundry", label: "Claude in Microsoft Foundry", wire: .anthropic,
             defaultUrl: "https://YOUR_RESOURCE.services.ai.azure.com/anthropic",
             urlRequired: true, keyName: "Resource key", keyOptional: false,
             hint: "The Foundry resource’s key. Put the resource name in the address.", catalog: claude),
        Kind(id: "vertex", label: "Claude on Vertex AI", wire: .vertex,
             defaultUrl: "https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/global",
             urlRequired: true, keyName: "Access token", keyOptional: false,
             hint: "A Google access token (gcloud auth print-access-token). It lasts about an hour: paste a new one when it runs out.",
             catalog: claude),
        Kind(id: "openai-compat", label: "OpenAI-compatible", wire: .openai, defaultUrl: "https://",
             urlRequired: true, keyName: "API key", keyOptional: true,
             hint: "Any server that speaks the OpenAI API over https: Groq, Together, Mistral, DeepSeek, your own.", catalog: []),
    ]

    /// The desktop's other kinds, and why they are not here.
    public struct ComputerOnly: Equatable, Sendable, Identifiable {
        public let label: String
        public let why: String
        public var id: String { label }
    }

    public static let notOnPhone: [ComputerOnly] = [
        ComputerOnly(label: "Claude subscription", why: "Runs Claude Code, which needs a computer."),
        ComputerOnly(label: "ChatGPT (subscription)", why: "Signs in on a computer; use an OpenAI API key here."),
        ComputerOnly(label: "Local model servers", why: "Ollama, LM Studio, vLLM and the Model Server run on a computer."),
    ]

    public static func kind(_ id: String) -> Kind? { kinds.first { $0.id == id } }

    /// Where a provider's key is kept in the Keychain.
    public static func keyName(_ providerId: String) -> String { "phone-provider-key.\(providerId)" }

    /// Anthropic's Vertex AI request version.
    static let vertexVersion = "vertex-2023-10-16"
    /// Replies are capped here; every model on the list takes at least this.
    public static let maxTokens = 8192
    /// What a chat on this iPhone knows about where it runs.
    public static let system = "You are Nekko Agent, answering on the user’s iPhone. In this chat you have no tools: you can’t see the user’s computers, files or the web. Answer in Markdown."

    public enum Problem: Error, Equatable, LocalizedError {
        case label, key, url, unknownKind
        public var errorDescription: String? {
            switch self {
            case .label: return String(localized: "Give the provider a name.")
            case .key: return String(localized: "Paste the key.")
            case .url: return String(localized: "The address must be a full https:// address.")
            case .unknownKind: return String(localized: "This kind of provider can’t run on the iPhone.")
            }
        }
    }

    /// A provider as the Add sheet made it, checked. The key is kept apart, in the Keychain.
    public static func make(id: String, kind kindId: String, label: String, baseUrl: String?, key: String?, workspaceId: String? = nil) throws -> PhoneProvider {
        guard let kind = kind(kindId) else { throw Problem.unknownKind }
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw Problem.label }
        var url = (baseUrl?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? kind.defaultUrl
        while url.hasSuffix("/") { url.removeLast() }
        guard let parsed = URL(string: url), parsed.scheme == "https", let host = parsed.host, !host.isEmpty,
              !url.contains(" "), !url.contains("YOUR_") else { throw Problem.url }
        let secret = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if secret.isEmpty && !kind.keyOptional { throw Problem.key }
        let workspace = workspaceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return PhoneProvider(id: id, kind: kind.id, label: label, baseUrl: url,
                             workspaceId: kind.id == "anthropic" && workspace?.isEmpty == false ? workspace : nil)
    }

    // MARK: Requests

    /// A chat turn's request: the whole conversation, streamed back.
    public static func chatRequest(_ p: PhoneProvider, key: String?, model: String, messages: [PhoneMessage],
                                   system: String? = PhoneProviders.system, maxTokens: Int = PhoneProviders.maxTokens) -> PhoneRequest {
        let turns: [JSONValue] = messages.compactMap { m in
            let text = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return .object(["role": .string(m.role.rawValue), "content": .string(m.text)])
        }
        switch p.wire {
        case .anthropic, .vertex:
            var body: [String: JSONValue] = ["max_tokens": .int(Int64(maxTokens)), "stream": true, "messages": .array(turns)]
            if let system { body["system"] = .string(system) }
            if p.wire == .vertex {
                // The model is in the address on Vertex AI, and the version in the body.
                body["anthropic_version"] = .string(vertexVersion)
                return PhoneRequest(url: "\(p.baseUrl)/publishers/anthropic/models/\(model):streamRawPredict",
                                    headers: headers(p, key: key), body: .object(body))
            }
            body["model"] = .string(model)
            return PhoneRequest(url: "\(p.baseUrl)/v1/messages", headers: headers(p, key: key), body: .object(body))
        case .openai:
            var all = turns
            if let system { all.insert(.object(["role": "system", "content": .string(system)]), at: 0) }
            var body: [String: JSONValue] = ["model": .string(model), "stream": true, "messages": .array(all)]
            // Ask for the reply's token count at the end of the stream, where it is known to be
            // accepted: an OpenAI-compatible server may turn down a field it doesn't know.
            if usageKinds.contains(p.kind) { body["stream_options"] = ["include_usage": true] }
            return PhoneRequest(url: "\(p.baseUrl)/chat/completions", headers: headers(p, key: key), body: .object(body))
        }
    }

    /// The OpenAI-wire kinds asked for `stream_options.include_usage`.
    static let usageKinds: Set<String> = ["openai", "openrouter"]

    /// The models list, or nil for a kind that has none to read.
    public static func modelsRequest(_ p: PhoneProvider, key: String?) -> PhoneRequest? {
        guard let kind = kind(p.kind), kind.listsModels else { return nil }
        switch p.wire {
        case .anthropic: return PhoneRequest(method: "GET", url: "\(p.baseUrl)/v1/models?limit=1000", headers: headers(p, key: key))
        case .openai: return PhoneRequest(method: "GET", url: "\(p.baseUrl)/models", headers: headers(p, key: key))
        case .vertex: return nil
        }
    }

    static func headers(_ p: PhoneProvider, key: String?) -> [String: String] {
        var h = ["Content-Type": "application/json"]
        let key = key ?? ""
        switch p.wire {
        case .anthropic:
            h["x-api-key"] = key
            h["anthropic-version"] = "2023-06-01"
            if let w = p.workspaceId { h["anthropic-workspace-id"] = w }
        case .vertex:
            h["Authorization"] = "Bearer \(key)"
        case .openai:
            if !key.isEmpty { h["Authorization"] = "Bearer \(key)" }
            if p.kind == "openrouter" { h["X-Title"] = "Nekko Agent" }
        }
        return h
    }

    // MARK: Answers

    /// The chat models in a models list, in the order given (Anthropic's is newest first).
    public static func models(from data: Data, kind: String) -> [PhoneModel] {
        guard let list = (try? JSONValue.parse(data))?["data"]?.array else { return [] }
        let all = list.compactMap { m -> PhoneModel? in
            guard let id = m.str("id"), !id.isEmpty else { return nil }
            return PhoneModel(id: id, name: m.str("display_name") ?? m.str("name") ?? id)
        }
        guard kind == "openai" else { return all }
        // OpenAI lists every model it serves; keep the ones that chat.
        let skip = ["embedding", "whisper", "tts", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search", "davinci", "babbage", "sora"]
        return all.filter { m in !skip.contains { m.id.contains($0) } }.sorted { $0.id > $1.id }
    }

    /// What a failed answer says, in its own words where it has some.
    public static func failure(status: Int, body: Data) -> String {
        let v = try? JSONValue.parse(body)
        let message = v?["error"]?.str("message") ?? v?.str("message") ?? v?["error"]?.string
            ?? v?.array?.first?["error"]?.str("message")
        let said = message.map { ": \($0)" } ?? ""
        switch status {
        case 401, 403: return String(localized: "The provider turned the key down (\(status))\(said)")
        case 404: return String(localized: "The provider doesn’t know that address or model (404)\(said)")
        case 429: return String(localized: "The provider is rate limiting this key (429)\(said)")
        default: return String(localized: "The provider answered \(status)\(said)")
        }
    }
}

/// A provider this iPhone calls itself. Holds no secret: the key is in the Keychain.
public struct PhoneProvider: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var kind: String
    public var label: String
    public var baseUrl: String
    /// Claude API only: the workspace an organization key bills to.
    public var workspaceId: String?
    public var enabled = true

    public init(id: String, kind: String, label: String, baseUrl: String, workspaceId: String? = nil, enabled: Bool = true) {
        self.id = id
        self.kind = kind
        self.label = label
        self.baseUrl = baseUrl
        self.workspaceId = workspaceId
        self.enabled = enabled
    }

    public var wire: PhoneProviders.Wire { PhoneProviders.kind(kind)?.wire ?? .openai }
    public var kindLabel: String { PhoneProviders.kind(kind)?.label ?? kind }
}

public struct PhoneModel: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

/// An HTTP request to a provider, built here and sent by the app (`PhoneHTTP`).
public struct PhoneRequest: Equatable, Sendable {
    public var method = "POST"
    public var url: String
    public var headers: [String: String]
    public var body: JSONValue?

    public init(method: String = "POST", url: String, headers: [String: String], body: JSONValue? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }

    public var bodyData: Data? { body.map { Data($0.serialized().utf8) } }
}

/// How the phone reaches a provider: URLSession in the app, a fake in tests.
public protocol PhoneHTTP: Sendable {
    /// The whole answer.
    func send(_ request: PhoneRequest) async throws -> (status: Int, body: Data)
    /// The answer's status, then its body line by line as it streams.
    func lines(_ request: PhoneRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, Error>)
}

/// What one line of a streamed answer says.
public enum PhoneStreamEvent: Equatable, Sendable {
    case text(String)
    /// The tokens the provider counted so far for this reply: each figure is the
    /// running total, nil when this line does not say it.
    case usage(input: Int64?, output: Int64?)
    case done
    case failed(String)
}

/// Reads a provider's server-sent events, Anthropic's and OpenAI's, one line at a time.
public struct PhoneStreamParser: Sendable {
    public init() {}

    public func read(_ line: String) -> [PhoneStreamEvent] {
        let line = line.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("data:") else { return [] }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return [.done] }
        guard let v = try? JSONValue.parse(payload) else { return [] }
        if let error = v["error"] {
            return [.failed(error.str("message") ?? error.string ?? String(localized: "The provider stopped with an error."))]
        }
        switch v.str("type") {
        case "content_block_delta":
            if v["delta"]?.str("type") == "text_delta", let t = v["delta"]?.str("text"), !t.isEmpty { return [.text(t)] }
            return []
        case "message_start":
            // The prompt's tokens, cache reads and writes included: all of them are billed.
            guard let u = v["message"]?["usage"], u.object != nil else { return [] }
            let input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].compactMap { u.long($0) }
            return [.usage(input: input.isEmpty ? nil : input.reduce(0, +), output: u.long("output_tokens"))]
        case "message_delta":
            // The reply's tokens so far (a running total).
            guard let out = v["usage"]?.long("output_tokens") else { return [] }
            return [.usage(input: nil, output: out)]
        case "message_stop":
            return [.done]
        default:
            break
        }
        // OpenAI's chat completion chunks. With `include_usage` the last chunk has
        // no choices and carries the whole reply's usage.
        var out: [PhoneStreamEvent] = []
        if let choice = v["choices"]?.array?.first, let t = choice["delta"]?.str("content"), !t.isEmpty { out.append(.text(t)) }
        if let u = v["usage"], u.object != nil, u.long("prompt_tokens") != nil || u.long("completion_tokens") != nil {
            out.append(.usage(input: u.long("prompt_tokens"), output: u.long("completion_tokens")))
        }
        return out
    }
}

/// A reply's token count as its stream reports it: the latest of each running total.
public struct PhoneTokenCount: Equatable, Sendable {
    public var input: Int64 = 0
    public var output: Int64 = 0
    public var reported = false

    public init() {}

    public mutating func add(_ e: PhoneStreamEvent) {
        guard case .usage(let i, let o) = e else { return }
        if let i { input = i }
        if let o { output = o }
        reported = true
    }
}
