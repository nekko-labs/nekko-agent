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
        /// Where the key is made, for the guided setup: open it, copy, come back, paste.
        public var keyPage: String? = nil
        /// OpenRouter: a browser sign-in hands the key back, nothing to copy.
        public var signIn = false
        /// It lists its own models (`GET /v1/models` or `/models`).
        public var listsModels: Bool { catalog.isEmpty }
    }

    static let claude: [PhoneModel] = [
        PhoneModel(id: "claude-opus-5-5", name: "Claude Opus 5.5"),
        PhoneModel(id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"),
        PhoneModel(id: "claude-fable-5-2", name: "Claude Fable 5.2"),
        PhoneModel(id: "claude-fable-5-1", name: "Claude Fable 5.1"),
        PhoneModel(id: "claude-haiku-5-5", name: "Claude Haiku 5.5"),
        PhoneModel(id: "claude-opus-4-8", name: "Claude Opus 4.8"),
        PhoneModel(id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6"),
    ]

    /// In the order the Add sheet lists them. Ids match the desktop's provider kinds.
    public static let kinds: [Kind] = [
        Kind(id: "anthropic", label: "Claude API", wire: .anthropic, defaultUrl: "https://api.anthropic.com",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from console.anthropic.com.", catalog: [],
             keyPage: "https://console.anthropic.com/settings/keys"),
        Kind(id: "openai", label: "OpenAI", wire: .openai, defaultUrl: "https://api.openai.com/v1",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from platform.openai.com.", catalog: [],
             keyPage: "https://platform.openai.com/api-keys"),
        Kind(id: "openrouter", label: "OpenRouter", wire: .openai, defaultUrl: "https://openrouter.ai/api/v1",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "An API key from openrouter.ai: one key for many model makers.", catalog: [],
             keyPage: "https://openrouter.ai/settings/keys", signIn: true),
        Kind(id: "gemini", label: "Google Gemini", wire: .openai, defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "A Google AI Studio key, billed apart from Google AI plans.", catalog: [],
             keyPage: "https://aistudio.google.com/apikey"),
        Kind(id: "ollama-cloud", label: "Ollama Cloud", wire: .openai, defaultUrl: "https://ollama.com/v1",
             urlRequired: false, keyName: "API key", keyOptional: false,
             hint: "Models hosted by Ollama, on an ollama.com key. No Ollama app needed.", catalog: [],
             keyPage: "https://ollama.com/settings/keys"),
        Kind(id: "bedrock", label: "Claude in Amazon Bedrock", wire: .anthropic,
             defaultUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
             urlRequired: true, keyName: "Bedrock API key", keyOptional: false,
             hint: "A short-lived Bedrock token, sent as x-api-key to Mantle Messages. Put your region in the address.",
             catalog: claude.filter { $0.id != "claude-sonnet-4-6" }.map { PhoneModel(id: "anthropic.\($0.id)", name: $0.name) }),
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

    // MARK: OpenRouter sign-in (PKCE; the answer is an API key)

    /// Where the sign-in comes back to; the app's own scheme, caught by the web session.
    public static let openRouterCallback = "nekko-agent://openrouter-key"

    public static func openRouterAuthorizeURL(challenge: String) -> URL {
        var c = URLComponents(string: "https://openrouter.ai/auth")!
        c.queryItems = [URLQueryItem(name: "callback_url", value: openRouterCallback),
                        URLQueryItem(name: "code_challenge", value: challenge),
                        URLQueryItem(name: "code_challenge_method", value: "S256")]
        return c.url!
    }

    /// The code from the callback, if it is ours and carries one.
    public static func openRouterCode(from callback: URL) -> String? {
        guard callback.absoluteString.hasPrefix(openRouterCallback),
              let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else { return nil }
        return code
    }

    public static func openRouterKeyRequest(code: String, verifier: String) -> PhoneRequest {
        PhoneRequest(url: "https://openrouter.ai/api/v1/auth/keys",
                     headers: ["Content-Type": "application/json", "Accept": "application/json"],
                     body: .object(["code": .string(code), "code_verifier": .string(verifier), "code_challenge_method": "S256"]))
    }

    public static func openRouterKey(from data: Data) -> String? {
        guard data.count <= 100_000, let key = (try? JSONValue.parse(data))?["key"]?.string,
              !key.isEmpty, headerValue(key) else { return nil }
        return key
    }

    /// Where a provider's key is kept in the Keychain.
    public static func keyName(_ providerId: String) -> String { "phone-provider-key.\(providerId)" }

    /// Anthropic's Vertex AI request version.
    static let vertexVersion = "vertex-2023-10-16"
    /// Replies are capped here; every model on the list takes at least this.
    public static let maxTokens = 8192
    /// What a chat on this iPhone knows about where it runs.
    public static let system = "You are Nekko Agent, answering on the user’s iPhone. In this chat you have no tools: you can’t see the user’s computers, files or the web. Answer in Markdown."

    public enum Problem: Error, Equatable, LocalizedError {
        case label, key, url, unknownKind, model, signIn
        public var errorDescription: String? {
            switch self {
            case .label: return String(localized: "Give the provider a name.")
            case .key: return String(localized: "Paste the key.")
            case .url: return String(localized: "The address must be a full https:// address.")
            case .model: return String(localized: "Choose a valid model and reply token limit.")
            case .unknownKind: return String(localized: "This kind of provider can’t run on the iPhone.")
            case .signIn: return String(localized: "OpenRouter didn’t hand back a key. Try again.")
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
              safeURL(url), !url.contains("YOUR_") else { throw Problem.url }
        let secret = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if secret.isEmpty && !kind.keyOptional { throw Problem.key }
        guard headerValue(secret), headerValue(workspaceId ?? "") else { throw Problem.key }
        let workspace = workspaceId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return PhoneProvider(id: id, kind: kind.id, label: label, baseUrl: url,
                             workspaceId: kind.id == "anthropic" && workspace?.isEmpty == false ? workspace : nil)
    }

    /// Validate persisted metadata again before attaching a credential.
    public static func validate(_ p: PhoneProvider, key: String?) throws {
        guard p.enabled else { throw Problem.unknownKind }
        guard p.baseUrl == p.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines) else { throw Problem.url }
        _ = try make(id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, key: key, workspaceId: p.workspaceId)
    }

    public static func headerValue(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { (32...126).contains($0.value) }
    }

    /// Also used by the platform transport for requests from any caller.
    public static func safeURL(_ value: String) -> Bool {
        guard let c = URLComponents(string: value), c.scheme == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.port == nil || (1...65535).contains(c.port!),
              !value.contains("\\"), !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) }),
              value.range(of: "(?i)%(2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)", options: .regularExpression) == nil,
              !c.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
        return true
    }

    // MARK: Requests

    /// A chat turn's request: the whole conversation, streamed back.
    public static func chatRequest(_ p: PhoneProvider, key: String?, model: String, messages: [PhoneMessage],
                                   system: String? = PhoneProviders.system, maxTokens: Int = PhoneProviders.maxTokens) throws -> PhoneRequest {
        try validate(p, key: key)
        guard !model.isEmpty, model.utf8.count <= 1024, !model.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), maxTokens > 0,
              p.wire != .vertex || model.range(of: "^[a-zA-Z0-9_-][a-zA-Z0-9@._-]*$", options: .regularExpression) != nil else { throw Problem.model }
        let turns: [JSONValue] = messages.compactMap { m in
            let text = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let photos = m.role == .user ? (m.images ?? []).compactMap(imagePart) : []
            guard !text.isEmpty || !photos.isEmpty else { return nil }
            guard !photos.isEmpty else { return .object(["role": .string(m.role.rawValue), "content": .string(m.text)]) }
            return .object(["role": .string(m.role.rawValue), "content": .array(content(text: text.isEmpty ? nil : m.text, photos: photos, wire: p.wire))])
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
            var body: [String: JSONValue] = ["model": .string(model), "stream": true, "messages": .array(all),
                                                  p.kind == "openai" ? "max_completion_tokens" : "max_tokens": .int(Int64(maxTokens))]
            // Ask for the reply's token count at the end of the stream, where it is known to be
            // accepted: an OpenAI-compatible server may turn down a field it doesn't know.
            if usageKinds.contains(p.kind) { body["stream_options"] = ["include_usage": true] }
            return PhoneRequest(url: "\(p.baseUrl)/chat/completions", headers: headers(p, key: key), body: .object(body))
        }
    }

    /// A message takes this many photos at most, as in a computer chat.
    public static let maxImages = 4
    /// The largest photo sent (a data URL); the composer's are about a tenth of this.
    static let maxImageBytes = 8_000_000

    /// A photo as providers take it, from an image data URL; nil for anything else.
    public static func imagePart(_ dataURL: String) -> ImagePart? {
        guard dataURL.utf8.count <= maxImageBytes,
              let match = dataURL.range(of: "^data:image/(jpeg|png|gif|webp);base64,", options: .regularExpression) else { return nil }
        let data = String(dataURL[match.upperBound...])
        guard !data.isEmpty, data.range(of: "^[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil else { return nil }
        let mediaType = String(dataURL[dataURL.index(dataURL.startIndex, offsetBy: 5)..<dataURL.firstIndex(of: ";")!])
        return ImagePart(url: dataURL, mediaType: mediaType, data: data)
    }

    public struct ImagePart: Equatable, Sendable {
        public let url: String
        public let mediaType: String
        public let data: String
    }

    /// A user turn with photos: Anthropic's image blocks before the text, or the OpenAI
    /// route's `image_url` parts after it (OpenRouter, Gemini, Ollama Cloud take the same).
    static func content(text: String?, photos: [ImagePart], wire: Wire) -> [JSONValue] {
        switch wire {
        case .anthropic, .vertex:
            var parts: [JSONValue] = photos.map { photo in
                .object(["type": "image", "source": .object(["type": "base64", "media_type": .string(photo.mediaType), "data": .string(photo.data)])])
            }
            if let text { parts.append(.object(["type": "text", "text": .string(text)])) }
            return parts
        case .openai:
            var parts: [JSONValue] = text.map { [.object(["type": "text", "text": .string($0)])] } ?? []
            parts += photos.map { .object(["type": "image_url", "image_url": .object(["url": .string($0.url)])]) }
            return parts
        }
    }

    /// The OpenAI-wire kinds asked for `stream_options.include_usage`.
    static let usageKinds: Set<String> = ["openai", "openrouter", "gemini"]

    /// The models list, or nil for a kind that has none to read.
    public static func modelsRequest(_ p: PhoneProvider, key: String?) throws -> PhoneRequest? {
        try validate(p, key: key)
        guard let kind = kind(p.kind), kind.listsModels else { return nil }
        var h = headers(p, key: key)
        h["Accept"] = "application/json"
        switch p.wire {
        case .anthropic: return PhoneRequest(method: "GET", url: "\(p.baseUrl)/v1/models?limit=1000", headers: h)
        case .openai: return PhoneRequest(method: "GET", url: "\(p.baseUrl)/models", headers: h)
        case .vertex: return nil
        }
    }

    /// For kinds whose models list answers without a valid key: a request a bad key is
    /// refused on (401/403). Ollama Cloud's asks for a model that doesn't exist, so it costs nothing.
    /// OpenAI lists models for a key with no credit, so its check is a tiny chat with `model`.
    public static func keyCheckRequest(_ p: PhoneProvider, key: String?, model: String? = nil) throws -> PhoneRequest? {
        try validate(p, key: key)
        var h = headers(p, key: key)
        h["Accept"] = "application/json"
        switch p.kind {
        case "openai":
            guard let model, !model.isEmpty, model.utf8.count <= 1024 else { return nil }
            // Reasoning models spend a few tokens before any text; 16 still costs next to nothing.
            return PhoneRequest(url: "\(p.baseUrl)/chat/completions", headers: h, body: .object([
                "model": .string(model), "max_completion_tokens": .int(16),
                "messages": .array([.object(["role": .string("user"), "content": .string("Say OK.")])]),
            ]))
        case "openrouter": return PhoneRequest(method: "GET", url: "\(p.baseUrl)/key", headers: h)
        case "ollama-cloud":
            return PhoneRequest(url: "\(p.baseUrl)/chat/completions", headers: h, body: .object([
                "model": .string("nekko-key-check"), "max_tokens": .int(1),
                "messages": .array([.object(["role": .string("user"), "content": .string(".")])]),
            ]))
        default: return nil
        }
    }

    static func headers(_ p: PhoneProvider, key: String?) -> [String: String] {
        var h = ["Content-Type": "application/json", "Accept": "text/event-stream"]
        let key = key ?? ""
        switch p.wire {
        case .anthropic:
            h["x-api-key"] = key
            h["anthropic-version"] = "2023-06-01"
            if p.kind == "anthropic", let w = p.workspaceId { h["anthropic-workspace-id"] = w }
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
        guard data.count <= 2_000_000, let list = (try? JSONValue.parse(data))?["data"]?.array else { return [] }
        let all = list.compactMap { m -> PhoneModel? in
            guard let id = m.str("id"), !id.isEmpty, id.utf8.count <= 1024, !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
            return PhoneModel(id: id, name: m.str("display_name") ?? m.str("name") ?? id, acceptsImages: acceptsImages(m, kind: kind), created: m.long("created"))
        }
        guard kind == "openai" || kind == "gemini" else { return all }
        // OpenAI and Gemini list every model they serve; keep the ones that chat.
        let skip = ["embedding", "whisper", "tts", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search", "davinci", "babbage", "sora", "imagen", "veo", "aqa"]
        return all.filter { m in !skip.contains { m.id.contains($0) } }.sorted { $0.id > $1.id }
    }

    /// Whether a listed model takes photos, where the list says: every Claude model does, and
    /// OpenRouter names each model's inputs. Nil (unknown) elsewhere.
    static func acceptsImages(_ m: JSONValue, kind: String) -> Bool? {
        if kind == "anthropic" { return true }
        guard kind == "openrouter", let inputs = m["architecture"]?["input_modalities"]?.array else { return nil }
        return inputs.contains { $0.string == "image" }
    }

    /// The model a new chat starts on when none was chosen: the newest one that is not a
    /// dated snapshot, a pro tier or a live (voice) model. Lists without dates keep their order.
    public static func defaultModel(_ list: [PhoneModel]) -> PhoneModel? {
        let plain = list.filter { m in
            let id = m.id.lowercased()
            return !isSnapshot(id) && !id.contains("-pro") && !id.contains("live")
        }
        let pool = plain.isEmpty ? list : plain
        guard pool.contains(where: { $0.created != nil }) else { return pool.first }
        // Stable: among equal dates the list's own order wins.
        return pool.enumerated().max { a, b in
            let (x, y) = (a.element.created ?? .min, b.element.created ?? .min)
            return x == y ? a.offset > b.offset : x < y
        }?.element
    }

    /// `o3-2025-04-16`, `claude-x-20250514`: a pinned copy of a model that also has a plain id.
    static func isSnapshot(_ id: String) -> Bool {
        id.range(of: #"-(\d{4}-\d{2}-\d{2}|\d{8})$"#, options: .regularExpression) != nil
    }

    /// The most a failed answer's body is read for its error code.
    public static let errorBodyBytes = 4096

    /// Our own explanation of a failed answer. Only the error's code and type are read and
    /// compared to known values: provider message text can echo part of the key, so it is never shown.
    public static func failure(status: Int, body: Data, headers: [String: String] = [:], kind: String = "") -> String {
        let code = errorCodes(body)
        let wait = retryAfter(headers)
        if code.contains("insufficient_quota") || status == 402 {
            return kind == "openai"
                ? String(localized: "This key has no credit. Add billing at platform.openai.com, then try again.")
                : String(localized: "This key has no credit left. Add billing with the provider, then try again.")
        }
        if code.contains("invalid_api_key") || code.contains("authentication_error") {
            return String(localized: "The provider turned the key down (\(status)). Check the key and paste it again.")
        }
        if code.contains("model_not_found") {
            return String(localized: "This key can’t use that model. Pick another one.")
        }
        if code.contains("overloaded_error") || status == 529 {
            return String(localized: "The provider is busy. Try again in a moment.")
        }
        if status == 429 || code.contains("rate_limit_exceeded") || code.contains("rate_limit_error") || code.contains("resource_exhausted") {
            guard let wait else { return String(localized: "Rate limited. Try again in a moment.") }
            if wait > 90 { return String(localized: "Rate limited. Try again in \(Int((wait / 60).rounded(.up))) min.") }
            return String(localized: "Rate limited. Try again in \(max(1, Int(wait.rounded(.up))))s.")
        }
        switch status {
        case 401, 403: return String(localized: "The provider turned the key down (\(status))")
        case 404: return String(localized: "The provider doesn’t know that address or model (404)")
        default: return String(localized: "The provider answered \(status)")
        }
    }

    /// The lowercased `error.code`, `error.type`, `error.status` and top-level `type` of an
    /// error body (OpenAI, Anthropic, Gemini's list form). Nothing else is read.
    static func errorCodes(_ body: Data) -> Set<String> {
        guard !body.isEmpty, body.count <= errorBodyBytes, let json = try? JSONValue.parse(body) else { return [] }
        let root = json.array?.first ?? json
        var out = Set<String>()
        for v in [root["error"]?["code"], root["error"]?["type"], root["error"]?["status"], root["type"]] {
            if let s = v?.string, s.count <= 64 { out.insert(s.lowercased()) }
        }
        return out
    }

    /// Seconds to wait from `retry-after`, else the sooner of OpenAI's `x-ratelimit-reset-*`.
    public static func retryAfter(_ headers: [String: String]) -> Double? {
        let h = lowercased(headers)
        if let s = h["retry-after"]?.trimmingCharacters(in: .whitespaces), let n = Double(s), n.isFinite, n >= 0 { return n }
        let resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"].compactMap { h[$0].flatMap(duration) }
        return resets.min()
    }

    /// OpenAI's reset durations: `1s`, `6m0s`, `20ms`, `1h2m3.5s`.
    static func duration(_ text: String) -> Double? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.count <= 32 else { return nil }
        var total = 0.0
        var rest = Substring(t)
        let units: [(String, Double)] = [("ms", 0.001), ("h", 3600), ("m", 60), ("s", 1)]
        while !rest.isEmpty {
            let digits = rest.prefix { $0.isNumber || $0 == "." }
            guard !digits.isEmpty, let n = Double(digits) else { return nil }
            rest = rest.dropFirst(digits.count)
            guard let (unit, scale) = units.first(where: { rest.hasPrefix($0.0) }) else { return nil }
            rest = rest.dropFirst(unit.count)
            total += n * scale
        }
        return total.isFinite ? total : nil
    }

    static func lowercased(_ headers: [String: String]) -> [String: String] {
        Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
    }
}

/// A key's request and token budget, as the provider last reported it in its answer's
/// headers (OpenAI's `x-ratelimit-*`, Anthropic's `anthropic-ratelimit-*`). Kept in memory only.
public struct PhoneRateLimits: Equatable, Sendable {
    public var requestsLimit: Int64?
    public var requestsRemaining: Int64?
    /// When the request budget is full again, in milliseconds since 1970.
    public var requestsResetAt: Int64?
    public var tokensLimit: Int64?
    public var tokensRemaining: Int64?
    public var tokensResetAt: Int64?
    /// When the answer that carried these arrived, in milliseconds since 1970.
    public var at: Int64

    public init(requestsLimit: Int64? = nil, requestsRemaining: Int64? = nil, requestsResetAt: Int64? = nil,
                tokensLimit: Int64? = nil, tokensRemaining: Int64? = nil, tokensResetAt: Int64? = nil, at: Int64) {
        self.requestsLimit = requestsLimit
        self.requestsRemaining = requestsRemaining
        self.requestsResetAt = requestsResetAt
        self.tokensLimit = tokensLimit
        self.tokensRemaining = tokensRemaining
        self.tokensResetAt = tokensResetAt
        self.at = at
    }

    /// The limits in an answer's headers, or nil when it carries none.
    public static func from(headers: [String: String], at: Int64) -> PhoneRateLimits? {
        let h = PhoneProviders.lowercased(headers)
        func count(_ name: String) -> Int64? { h[name].flatMap { Int64($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 >= 0 ? $0 : nil } }
        func reset(_ name: String) -> Int64? {
            guard let v = h[name] else { return nil }
            if let s = PhoneProviders.duration(v) { return at + Int64((s * 1000).rounded()) }
            if let d = ISO8601DateFormatter().date(from: v.trimmingCharacters(in: .whitespaces)) { return Int64(d.timeIntervalSince1970 * 1000) }
            return nil
        }
        var r = PhoneRateLimits(at: at)
        for prefix in ["x-ratelimit-", "anthropic-ratelimit-"] {
            r.requestsLimit = r.requestsLimit ?? count("\(prefix)limit-requests") ?? count("\(prefix)requests-limit")
            r.requestsRemaining = r.requestsRemaining ?? count("\(prefix)remaining-requests") ?? count("\(prefix)requests-remaining")
            r.requestsResetAt = r.requestsResetAt ?? reset("\(prefix)reset-requests") ?? reset("\(prefix)requests-reset")
            r.tokensLimit = r.tokensLimit ?? count("\(prefix)limit-tokens") ?? count("\(prefix)tokens-limit")
            r.tokensRemaining = r.tokensRemaining ?? count("\(prefix)remaining-tokens") ?? count("\(prefix)tokens-remaining")
            r.tokensResetAt = r.tokensResetAt ?? reset("\(prefix)reset-tokens") ?? reset("\(prefix)tokens-reset")
        }
        return r == PhoneRateLimits(at: at) ? nil : r
    }

    /// The token and request budgets as limit windows (#2923), each used against its limit.
    /// A budget past its reset time is full again, so it reads as unused.
    public func providerLimits(now: Int64) -> ProviderLimits {
        func window(_ id: String, _ label: String, _ limit: Int64?, _ remaining: Int64?, _ resetAt: Int64?) -> ProviderLimits.Window? {
            guard let limit, limit > 0, let remaining else { return nil }
            if let resetAt, resetAt <= now { return ProviderLimits.Window(id: id, label: label, usedPercent: 0, resetAt: nil, status: "allowed") }
            let used = Double(limit - min(remaining, limit)) / Double(limit) * 100
            return ProviderLimits.Window(id: id, label: label, usedPercent: used, resetAt: resetAt, status: remaining == 0 ? "rate_limited" : "allowed")
        }
        let windows = [window("tokens", "per-minute token", tokensLimit, tokensRemaining, tokensResetAt),
                       window("requests", "per-minute request", requestsLimit, requestsRemaining, requestsResetAt)]
        return ProviderLimits(planType: nil, windows: windows.compactMap { $0 }, updatedAt: at)
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
    /// Takes photos: true or false where the provider says, nil when it doesn't.
    public var acceptsImages: Bool?
    /// When the provider published it (OpenAI's `created`, seconds since 1970), if it says.
    public var created: Int64?
    public init(id: String, name: String, acceptsImages: Bool? = nil, created: Int64? = nil) {
        self.id = id; self.name = name; self.acceptsImages = acceptsImages; self.created = created
    }
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
/// Header names come back lowercased.
public protocol PhoneHTTP: Sendable {
    /// The whole answer.
    func send(_ request: PhoneRequest) async throws -> (status: Int, headers: [String: String], body: Data)
    /// The answer's status and headers, then its body line by line as it streams.
    func lines(_ request: PhoneRequest) async throws -> (status: Int, headers: [String: String], lines: AsyncThrowingStream<String, Error>)
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
    public static let maxFrameBytes = 1_000_000
    public static let maxStreamBytes = 8_000_000
    public static let maxTextBytes = 2_000_000
    private var data: [String] = []
    private var event = ""
    private var frameBytes = 0
    private var streamBytes = 0
    private var textBytes = 0
    private var terminal = false
    public init() {}

    public mutating func line(_ line: String) -> [PhoneStreamEvent] {
        guard !terminal else { return [] }
        let size = line.utf8.count + 1
        frameBytes += size
        streamBytes += size
        guard frameBytes <= Self.maxFrameBytes, streamBytes <= Self.maxStreamBytes else {
            terminal = true
            return [.failed("The provider's stream is too large.")]
        }
        if !line.isEmpty {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            var value = parts.count > 1 ? String(parts[1]) : ""
            if value.hasPrefix(" ") { value.removeFirst() }
            if parts.first == "data" { data.append(value) }
            if parts.first == "event" { event = value }
            return []
        }
        defer { data = []; event = ""; frameBytes = 0 }
        if event == "error" { terminal = true; return [.failed("The provider stopped with an error. Test the provider and retry.")] }
        guard !data.isEmpty else { return [] }
        let payload = data.joined(separator: "\n")
        guard payload == "[DONE]" || (try? JSONValue.parse(payload))?.object != nil else {
            terminal = true
            return [.failed("The provider sent an unreadable stream.")]
        }
        if payload != "[DONE]", let v = try? JSONValue.parse(payload) {
            if let choices = v["choices"], choices.array == nil || choices.array?.contains(where: { $0.object == nil }) == true {
                terminal = true
                return [.failed("The provider sent an unreadable stream.")]
            }
            if v.str("type") == "content_block_delta" && v["delta"]?.object == nil {
                terminal = true
                return [.failed("The provider sent an unreadable stream.")]
            }
        }
        let events = read("data: " + payload)
        for e in events {
            switch e {
            case .done, .failed: terminal = true
            case .text(let text): textBytes += text.utf8.count
            case .usage: break
            }
        }
        guard textBytes <= Self.maxTextBytes else { terminal = true; return [.failed("The provider's reply is too large.")] }
        return events
    }

    public func read(_ line: String) -> [PhoneStreamEvent] {
        let line = line.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("data:") else { return [] }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return [.done] }
        guard let v = try? JSONValue.parse(payload) else { return [] }
        if v["error"] != nil && v["error"] != .null || v.str("type") == "error" {
            return [.failed("The provider stopped with an error. Test the provider and retry.")]
        }
        switch v.str("type") {
        case "content_block_delta":
            if v["delta"]?.str("type") == "text_delta", let t = v["delta"]?.str("text"), !t.isEmpty { return [.text(t)] }
            return []
        case "message_start":
            // The prompt's tokens, cache reads and writes included: all of them are billed.
            guard let u = v["message"]?["usage"], u.object != nil else { return [] }
            let input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].compactMap { u.long($0) }
            return [.usage(input: input.isEmpty ? nil : input.filter { $0 >= 0 }.reduce(0) { total, value in total.addingReportingOverflow(value).overflow ? Int64.max : total + value }, output: u.long("output_tokens"))]
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
        if let i, i >= 0 { input = min(i, 1_000_000_000) }
        if let o, o >= 0 { output = min(o, 1_000_000_000) }
        reported = true
    }
}
