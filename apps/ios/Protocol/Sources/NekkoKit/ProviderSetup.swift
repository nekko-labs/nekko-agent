import Foundation
import NekkoProtocol
import Observation

/// Setting up a model provider on a computer from this iPhone (decision 0016):
/// the phone *carries* the key, sealed to the computer's own key, and never
/// holds, stores or reads one. The computer tests it, keeps it, and answers
/// with the models it can now use; the key is never in a saved transcript,
/// a log or a diagnostics report.
public enum ProviderSetup {
    /// The sealed box's context, the same string the computer opens under.
    public static let context = "nekko-provider-key-v1"

    /// A kind a phone may add, in the order the sheet shows them.
    public struct Kind: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        /// Needs an API key (and an https base URL).
        public let needsKey: Bool
        /// Takes a base URL (a local server, or an OpenAI-compatible one).
        public let takesUrl: Bool
        public let defaultUrl: String
    }

    public static let kinds: [Kind] = [
        Kind(id: "anthropic", label: "Anthropic", needsKey: true, takesUrl: false, defaultUrl: "https://api.anthropic.com"),
        Kind(id: "openai", label: "OpenAI", needsKey: true, takesUrl: false, defaultUrl: "https://api.openai.com/v1"),
        Kind(id: "openrouter", label: "OpenRouter", needsKey: true, takesUrl: false, defaultUrl: "https://openrouter.ai/api/v1"),
        Kind(id: "ollama", label: "Ollama", needsKey: false, takesUrl: true, defaultUrl: "http://localhost:11434"),
        Kind(id: "lmstudio", label: "LM Studio", needsKey: false, takesUrl: true, defaultUrl: "http://localhost:1234/v1"),
        Kind(id: "vllm", label: "vLLM", needsKey: false, takesUrl: true, defaultUrl: "http://localhost:8000/v1"),
        Kind(id: "openai-compat", label: "OpenAI-compatible", needsKey: false, takesUrl: true, defaultUrl: "http://localhost:8080/v1"),
    ]

    public static func kind(_ id: String) -> Kind? { kinds.first { $0.id == id } }

    /// A provider id from its label: lowercase, dashes, unique among `existing`.
    public static func id(for label: String, kind: String, existing: [String]) -> String {
        var slug = label.lowercased().unicodeScalars.map { c -> Character in
            (c.properties.isAlphabetic && c.isASCII) || ("0"..."9").contains(c) ? Character(c) : "-"
        }.reduce(into: "") { out, c in if !(c == "-" && out.last == "-") { out.append(c) } }
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if slug.isEmpty { slug = kind }
        slug = String(slug.prefix(56))
        var candidate = slug
        var n = 2
        while existing.contains(candidate) {
            candidate = "\(slug)-\(n)"
            n += 1
        }
        return candidate
    }

    public enum Problem: Error, Equatable, LocalizedError {
        case label, key, url, computerKey
        public var errorDescription: String? {
            switch self {
            case .label: return String(localized: "Give the provider a name.")
            case .key: return String(localized: "Paste the API key.")
            case .url: return String(localized: "The address must start with http:// or https://.")
            case .computerKey: return String(localized: "The computer didn’t send a key to seal to. Update Nekko Agent there.")
            }
        }
    }

    /// The `providers:saveSealed` argument: the provider without its key, and
    /// the key sealed to `computerKey` (the computer's X9.63 public key).
    /// `key` is used once, here, and never kept.
    public static func request(id: String, kind kindId: String, label: String, baseUrl: String?, key: String?, computerKey: Data) throws -> JSONValue {
        guard let kind = kind(kindId) else { throw Problem.url }
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw Problem.label }
        var o: [String: JSONValue] = ["id": .string(id), "kind": .string(kind.id), "label": .string(label)]
        if let url = baseUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty, url != kind.defaultUrl || kind.takesUrl {
            guard url.hasPrefix("https://") || (url.hasPrefix("http://") && !kind.needsKey), !url.contains(" ") else { throw Problem.url }
            o["baseUrl"] = .string(url)
        }
        let secret = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if kind.needsKey && secret.isEmpty { throw Problem.key }
        if !secret.isEmpty {
            guard computerKey.count == 65 else { throw Problem.computerKey }
            let blob = try SyncCrypto.seal(to: computerKey, context: context, plaintext: Data(secret.utf8))
            o["sealedKey"] = .string(blob)
        }
        return .object(o)
    }
}

/// The sheet's state: the computer's sealing key, the save, and the switch.
@MainActor
@Observable
public final class ProviderSetupModel {
    public private(set) var busy = false
    public private(set) var failed: String?
    /// The models the computer listed after a save, so the sheet can say it worked.
    public private(set) var saved: ProviderSaveResult?

    private let store: ComputersStore

    public init(store: ComputersStore) { self.store = store }

    /// Seal the key to the computer and save the provider there. The key is in
    /// memory for this call only. Throws nothing: `failed` says what went wrong.
    public func save(id: String, kind: String, label: String, baseUrl: String?, key: String?) async -> Bool {
        busy = true
        failed = nil
        defer { busy = false }
        do {
            let raw = try await store.call(read: Channels.providersSealKey)
            guard raw.str("context") == ProviderSetup.context, let text = raw.str("publicKey"),
                  let computerKey = try? SyncCrypto.fromBase64url(text) else { throw ProviderSetup.Problem.computerKey }
            let request = try ProviderSetup.request(id: id, kind: kind, label: label, baseUrl: baseUrl, key: key, computerKey: computerKey)
            let result = ProviderSaveResult.from(try await store.call(change: Channels.providersSaveSealed, [request], timeout: 60))
            if result.ok {
                saved = result
                store.reloadList()
                return true
            }
            failed = result.message ?? String(localized: "The computer couldn’t save the provider.")
            return false
        } catch {
            failed = error.localizedDescription
            return false
        }
    }

    /// Turn one provider on or off on the computer (Face ID, like every change).
    public func setEnabled(_ id: String, _ enabled: Bool) async -> Bool {
        failed = nil
        do {
            let result = ProviderSaveResult.from(try await store.call(change: Channels.providersSetEnabled, [.string(id), .bool(enabled)]))
            if !result.ok { failed = result.message ?? String(localized: "The computer couldn’t change the provider.") }
            return result.ok
        } catch {
            failed = error.localizedDescription
            return false
        }
    }
}
