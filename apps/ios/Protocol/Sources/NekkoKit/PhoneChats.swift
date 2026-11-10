import Foundation
import NekkoProtocol
import Observation

/// One message of a chat that runs on this iPhone.
public struct PhoneMessage: Codable, Equatable, Sendable, Identifiable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public let id: String
    public let role: Role
    public var text: String
    public let at: Int64
    /// Why the reply stopped short, when it did.
    public var error: String?
    /// Persisted marker so partial replies are recognized after process death.
    public var incomplete: Bool?

    public init(id: String, role: Role, text: String, at: Int64, error: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.at = at
        self.error = error
    }
}

/// A chat that runs on this iPhone: its provider and model, and its messages.
public struct PhoneChat: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var title: String
    public var providerId: String
    public var modelId: String
    public let createdAt: Int64
    public var updatedAt: Int64
    public var archivedAt: Int64?
    public var pinned = false
    public var messages: [PhoneMessage] = []

    public init(id: String, title: String, providerId: String, modelId: String, createdAt: Int64) {
        self.id = id
        self.title = title
        self.providerId = providerId
        self.modelId = modelId
        self.createdAt = createdAt
        updatedAt = createdAt
    }

    /// As the chat list reads a computer's chats.
    public var summary: SessionSummary? {
        var o: [String: JSONValue] = [
            "id": .string(id), "title": .string(title), "updatedAt": .int(updatedAt), "createdAt": .int(createdAt),
            "exchangeCount": .int(Int64(messages.filter { $0.role == .user }.count)),
            "modelId": .string(modelId), "providerId": .string(providerId), "pinned": .bool(pinned),
        ]
        if let at = archivedAt { o["archivedAt"] = .int(at) }
        if let first = messages.first(where: { $0.role == .user })?.text { o["firstUserText"] = .string(first) }
        if let last = messages.last(where: { $0.role == .assistant && !$0.text.isEmpty })?.text { o["lastReplyText"] = .string(last) }
        return SessionSummary.from(.object(o))
    }

    /// A title from the first message: its first line, cut at a word.
    static func title(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard line.count > 60 else { return line }
        let cut = line.prefix(60)
        return (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
    }
}

/// This iPhone as a place chats run (decision 0050): its providers (keys in the
/// Keychain), their models, and its chats, kept in a file of their own under
/// Application Support beside the drafts, out of backups. Nothing here is sent
/// anywhere but to the provider a chat runs on.
@MainActor
@Observable
public final class PhoneChats {
    public private(set) var providers: [PhoneProvider] = []
    public private(set) var chats: [PhoneChat] = []
    public private(set) var models: [String: [PhoneModel]] = [:]
    public private(set) var modelErrors: [String: String] = [:]
    /// Chats whose reply is streaming in now.
    public private(set) var running: Set<String> = []
    /// The tokens this iPhone's chats used, by provider, model and day. Kept on the phone only.
    public private(set) var usage = PhoneUsageLedger()
    public private(set) var tone: PhoneTone = .standard

    private let secrets: SecureStore
    private let files: OfflineFiles?
    private let http: PhoneHTTP
    private let now: () -> Int64
    private let newId: () -> String
    @ObservationIgnored private var attempts: [String: String] = [:]
    @ObservationIgnored private var providerEpoch: [String: UUID] = [:]
    @ObservationIgnored private var modelLoads: [String: UUID] = [:]
    @ObservationIgnored private var counts: [String: PhoneTokenCount] = [:]
    @ObservationIgnored private var modelTasks: [String: Task<(status: Int, body: Data), Error>] = [:]
    @ObservationIgnored private var tests: [UUID: (String, Task<String?, Never>)] = [:]
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]

    static let file = "phone-chats"
    static let providersFile = "phone-providers"
    static let usageFile = "phone-usage"
    static let toneFile = "phone-tone"

    public init(secrets: SecureStore, files: OfflineFiles?, http: PhoneHTTP,
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                newId: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.secrets = secrets
        self.files = files
        self.http = http
        self.now = now
        self.newId = newId
        providers = Self.decode([PhoneProvider].self, files?.load(PhoneProviders.computerId, Self.providersFile)) ?? []
        chats = Self.decode([PhoneChat].self, files?.load(PhoneProviders.computerId, Self.file)) ?? []
        usage = Self.decode(PhoneUsageLedger.self, files?.load(PhoneProviders.computerId, Self.usageFile)) ?? PhoneUsageLedger()
        tone = Self.decode(PhoneTone.self, files?.load(PhoneProviders.computerId, Self.toneFile)) ?? .standard
        // A reply cut off when the app was closed is not still coming.
        for i in chats.indices {
            if let j = chats[i].messages.indices.last, chats[i].messages[j].role == .assistant, (chats[i].messages[j].incomplete == true || chats[i].messages[j].text.isEmpty),
               chats[i].messages[j].error == nil {
                chats[i].messages[j].error = String(localized: "Stopped when the app closed.")
                chats[i].messages[j].incomplete = false
            }
        }
    }

    /// The phone runs chats: it has a provider that is on.
    public var isSetUp: Bool { providers.contains(where: \.enabled) }

    /// The chat list's rows: every top-level chat, newest first.
    public var summaries: [SessionSummary] {
        chats.compactMap(\.summary).sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Working chats, for the list's status glyphs.
    public var activity: [String: Activity] {
        Dictionary(uniqueKeysWithValues: running.map { ($0, Activity.running) })
    }

    public func chat(_ id: String) -> PhoneChat? { chats.first { $0.id == id } }
    public func provider(_ id: String) -> PhoneProvider? { providers.first { $0.id == id } }

    /// Applies on the next turn; never rewrites saved messages or the provider identity.
    public func setTone(_ value: PhoneTone) {
        tone = value
        if let files, let data = Self.encode(value) { files.save(PhoneProviders.computerId, Self.toneFile, data) }
    }

    // MARK: Providers

    /// Add a provider, its key to the Keychain, and read its models.
    @discardableResult
    public func add(kind: String, label: String, baseUrl: String?, key: String?, workspaceId: String? = nil) throws -> PhoneProvider {
        let id = ProviderSetup.id(for: label, kind: kind, existing: providers.map(\.id))
        let p = try PhoneProviders.make(id: id, kind: kind, label: label, baseUrl: baseUrl, key: key, workspaceId: workspaceId)
        let secret = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        secrets.set(PhoneProviders.keyName(id), secret.isEmpty ? nil : secret)
        providers.append(p)
        saveProviders()
        return p
    }

    /// A new key for a provider (a Vertex AI token runs out in an hour).
    public func setKey(_ providerId: String, _ key: String) {
        guard provider(providerId) != nil, PhoneProviders.headerValue(key) else { return }
        invalidate(providerId)
        let secret = key.trimmingCharacters(in: .whitespacesAndNewlines)
        secrets.set(PhoneProviders.keyName(providerId), secret.isEmpty ? nil : secret)
        modelErrors[providerId] = nil
    }

    public func hasKey(_ providerId: String) -> Bool { secrets.get(PhoneProviders.keyName(providerId)) != nil }

    public func setEnabled(_ providerId: String, _ on: Bool) {
        guard let i = providers.firstIndex(where: { $0.id == providerId }) else { return }
        if !on { invalidate(providerId) }
        providers[i].enabled = on
        saveProviders()
    }

    /// Remove a provider and its key. Its chats stay, to read; they can't send until it is back.
    public func remove(_ providerId: String) {
        invalidate(providerId)
        secrets.set(PhoneProviders.keyName(providerId), nil)
        providers.removeAll { $0.id == providerId }
        models[providerId] = nil
        modelErrors[providerId] = nil
        saveProviders()
    }

    /// A provider's models: its list, or the kind's catalog. A failure is kept in `modelErrors`.
    @discardableResult
    public func loadModels(_ providerId: String) async -> [PhoneModel] {
        guard let p = provider(providerId), p.enabled, let kind = PhoneProviders.kind(p.kind) else { return [] }
        let epoch = providerEpoch[providerId]
        let load = UUID()
        modelLoads[providerId] = load
        do {
            guard let req = try PhoneProviders.modelsRequest(p, key: key(providerId)) else {
                models[providerId] = kind.catalog
                modelErrors[providerId] = nil
                return kind.catalog
            }
            modelTasks[providerId]?.cancel()
            let http = self.http
            let task = Task { try Task.checkCancellation(); return try await http.send(req) }
            modelTasks[providerId] = task
            defer { if modelLoads[providerId] == load { modelTasks[providerId] = nil } }
            let (status, body) = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            try Task.checkCancellation()
            guard providerEpoch[providerId] == epoch, modelLoads[providerId] == load, provider(providerId) == p else { return [] }
            guard (200..<300).contains(status) else {
                modelErrors[providerId] = PhoneProviders.failure(status: status, body: body)
                return []
            }
            let list = PhoneProviders.models(from: body, kind: p.kind)
            models[providerId] = list
            modelErrors[providerId] = list.isEmpty ? String(localized: "The provider listed no models.") : nil
            return list
        } catch {
            guard !Task.isCancelled, providerEpoch[providerId] == epoch, modelLoads[providerId] == load, provider(providerId) == p else { return [] }
            modelErrors[providerId] = "Could not load models. Check the address and key, then retry."
            return []
        }
    }

    public func loadAllModels() async {
        for p in providers where p.enabled { await loadModels(p.id) }
    }

    /// Check a provider works: its models list, or for a kind with none, a one-word reply.
    public func test(_ providerId: String) async -> String? {
        let id = UUID()
        let task = Task { await self.testProvider(providerId) }
        tests[id] = (providerId, task)
        defer { tests[id] = nil }
        return await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
    }

    private func testProvider(_ providerId: String) async -> String? {
        guard let p = provider(providerId), p.enabled, let kind = PhoneProviders.kind(p.kind) else { return String(localized: "Unknown provider.") }
        if kind.listsModels {
            let list = await loadModels(providerId)
            return modelErrors[providerId] ?? (list.isEmpty ? String(localized: "The provider listed no models.") : nil)
        }
        models[providerId] = kind.catalog
        guard let model = kind.catalog.first?.id else { return nil }
        let epoch = providerEpoch[providerId]
        do {
            let req = try PhoneProviders.chatRequest(p, key: key(providerId), model: model,
                messages: [PhoneMessage(id: "t", role: .user, text: "Say OK.", at: now())], system: nil, maxTokens: 8)
            try Task.checkCancellation()
            let (status, lines) = try await http.lines(req)
            try Task.checkCancellation()
            guard providerEpoch[providerId] == epoch, provider(providerId) == p else { return "Provider changed. Test again." }
            guard (200..<300).contains(status) else { return PhoneProviders.failure(status: status, body: Data()) }
            var parser = PhoneStreamParser()
            for try await line in lines {
                try Task.checkCancellation()
                guard providerEpoch[providerId] == epoch, provider(providerId) == p else { return "Provider changed. Test again." }
                for e in parser.line(line) {
                    switch e {
                    case .done: return nil
                    case .text, .usage: continue
                    case .failed(let why): return why
                    }
                }
            }
            return "The provider's stream ended before completion."
        } catch {
            return Task.isCancelled ? "Stopped." : "Could not test the provider. Check the address and key, then retry."
        }
    }

    // MARK: Chats

    /// Start a chat here and send its first message.
    public func create(providerId: String, modelId: String, first: String) -> String {
        let id = PhoneProviders.chatPrefix + newId()
        var chat = PhoneChat(id: id, title: PhoneChat.title(from: first), providerId: providerId, modelId: modelId, createdAt: now())
        if chat.title.isEmpty { chat.title = String(localized: "New chat") }
        chats.append(chat)
        send(id, first)
        return id
    }

    /// Add the user's message and stream the reply.
    public func send(_ chatId: String, _ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !running.contains(chatId), let i = index(chatId) else { return }
        chats[i].messages.append(PhoneMessage(id: newId(), role: .user, text: text, at: now()))
        chats[i].archivedAt = nil
        reply(chatId)
    }

    /// Ask again after a reply that failed or was stopped: the last one is replaced.
    public func retry(_ chatId: String) {
        guard !running.contains(chatId), let i = index(chatId) else { return }
        if chats[i].messages.last?.role == .assistant { chats[i].messages.removeLast() }
        guard chats[i].messages.last?.role == .user else { return }
        reply(chatId)
    }

    public func stop(_ chatId: String) {
        tasks[chatId]?.cancel()
        if let answer = attempts[chatId] { finish(chatId, answer, error: String(localized: "Stopped.")) }
    }

    /// Run the chat on another of this iPhone's providers or models from its next message on.
    public func setModel(_ chatId: String, providerId: String, modelId: String) {
        guard let i = index(chatId) else { return }
        chats[i].providerId = providerId
        chats[i].modelId = modelId
        save()
    }

    public func rename(_ chatId: String, to title: String) {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let i = index(chatId) else { return }
        chats[i].title = t
        save()
    }

    public func setPinned(_ chatId: String, _ pinned: Bool) {
        guard let i = index(chatId) else { return }
        chats[i].pinned = pinned
        save()
    }

    public func complete(_ chatId: String) {
        guard let i = index(chatId) else { return }
        stop(chatId)
        chats[i].archivedAt = now()
        save()
    }

    public func restore(_ chatId: String) {
        guard let i = index(chatId) else { return }
        chats[i].archivedAt = nil
        save()
    }

    public func delete(_ chatId: String) {
        stop(chatId)
        chats.removeAll { $0.id == chatId }
        save()
    }

    /// Forget everything on this iPhone: every provider, its key, and every chat.
    public func forgetAll() {
        for id in Array(tasks.keys) { stop(id) }
        for task in modelTasks.values { task.cancel() }
        modelTasks = [:]
        for (_, task) in tests.values { task.cancel() }
        for p in providers { providerEpoch[p.id] = UUID() }
        modelLoads = [:]
        for p in providers { secrets.set(PhoneProviders.keyName(p.id), nil) }
        providers = []
        chats = []
        models = [:]
        modelErrors = [:]
        usage = PhoneUsageLedger()
        tone = .standard
        files?.remove(PhoneProviders.computerId)
    }

    /// Wait for a chat's reply to finish (tests).
    public func settled(_ chatId: String) async {
        await tasks[chatId]?.value
    }

    private func reply(_ chatId: String) {
        guard let i = index(chatId) else { return }
        let chat = chats[i]
        let history = chat.messages
        let answerId = newId()
        chats[i].messages.append(PhoneMessage(id: answerId, role: .assistant, text: "", at: now()))
        chats[i].messages[chats[i].messages.count - 1].incomplete = true
        attempts[chatId] = answerId
        chats[i].updatedAt = now()
        save()
        guard let p = provider(chat.providerId), p.enabled else {
            finish(chatId, answerId, error: String(localized: "This chat’s provider isn’t on this iPhone any more. Pick another model."))
            return
        }
        let request: PhoneRequest
        do { request = try PhoneProviders.chatRequest(p, key: key(p.id), model: chat.modelId, messages: history, system: tone.systemPrompt) }
        catch { finish(chatId, answerId, error: "Check the provider address, key and model, then retry."); return }
        running.insert(chatId)
        let http = self.http
        tasks[chatId] = Task { [weak self] in
            var failure: String?
            var count = PhoneTokenCount()
            var completed = false
            do {
                try Task.checkCancellation()
                let (status, lines) = try await http.lines(request)
                try Task.checkCancellation()
                if !(200..<300).contains(status) {
                    failure = PhoneProviders.failure(status: status, body: Data())
                } else {
                    var parser = PhoneStreamParser()
                    read: for try await line in lines {
                        try Task.checkCancellation()
                        guard self?.attempts[chatId] == answerId else { return }
                        for e in parser.line(line) {
                            switch e {
                            case .text(let t): self?.append(chatId, answerId, t)
                            case .usage:
                                count.add(e)
                                self?.counts[chatId] = count
                            case .done: completed = true; break read
                            case .failed(let why):
                                failure = why
                                break read
                            }
                        }
                    }
                    if !completed && failure == nil { failure = "The provider’s stream ended before completion. Try again." }
                    // A cancelled stream ends rather than throwing.
                    if Task.isCancelled && failure == nil { failure = String(localized: "Stopped.") }
                }
            } catch is CancellationError {
                failure = String(localized: "Stopped.")
            } catch {
                failure = Task.isCancelled ? String(localized: "Stopped.") : "Could not reach the provider. Check the connection and retry."
            }
            guard self?.attempts[chatId] == answerId else { return }
            self?.finish(chatId, answerId, error: failure)
        }
    }

    private func record(_ p: PhoneProvider, model: String, _ count: PhoneTokenCount) {
        usage.record(providerId: p.id, providerLabel: p.label, model: model, input: count.input, output: count.output, at: now())
        guard let files, let v = Self.encode(usage) else { return }
        files.save(PhoneProviders.computerId, Self.usageFile, v)
    }

    private func append(_ chatId: String, _ answerId: String, _ text: String) {
        guard let i = index(chatId), let j = chats[i].messages.lastIndex(where: { $0.id == answerId }) else { return }
        guard attempts[chatId] == answerId else { return }
        chats[i].messages[j].text += text
        save()
    }

    private func finish(_ chatId: String, _ answerId: String, error: String?) {
        guard attempts[chatId] == answerId else { return }
        if let count = counts.removeValue(forKey: chatId), count.reported,
           let chat = chat(chatId), let p = provider(chat.providerId) { record(p, model: chat.modelId, count) }
        attempts[chatId] = nil
        running.remove(chatId)
        tasks[chatId] = nil
        guard let i = index(chatId) else { return }
        if let j = chats[i].messages.lastIndex(where: { $0.id == answerId }) {
            chats[i].messages[j].error = error ?? (chats[i].messages[j].text.isEmpty ? "The provider returned no text. Try another model." : nil)
            chats[i].messages[j].incomplete = false
        }
        chats[i].updatedAt = now()
        save()
    }

    private func index(_ chatId: String) -> Int? { chats.firstIndex { $0.id == chatId } }
    private func key(_ providerId: String) -> String? { secrets.get(PhoneProviders.keyName(providerId)) }

    private func save() {
        guard let files, let v = Self.encode(chats) else { return }
        files.save(PhoneProviders.computerId, Self.file, v)
    }

    private func saveProviders() {
        guard let files, let v = Self.encode(providers) else { return }
        files.save(PhoneProviders.computerId, Self.providersFile, v)
    }

    private func invalidate(_ providerId: String) {
        providerEpoch[providerId] = UUID()
        modelTasks.removeValue(forKey: providerId)?.cancel()
        for (id, (provider, task)) in Array(tests) where provider == providerId { task.cancel(); tests[id] = nil }
        modelLoads[providerId] = nil
        models[providerId] = nil
        modelErrors[providerId] = nil
        for chat in chats where chat.providerId == providerId { stop(chat.id) }
    }

    static func encode<T: Encodable>(_ value: T) -> JSONValue? {
        (try? JSONEncoder().encode(value)).flatMap { try? JSONValue.parse($0) }
    }

    static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue?) -> T? {
        guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

#if DEBUG
extension PhoneChats {
    /// Native UI fixture: in-memory only, no provider or credential and no HTTP.
    public func seedComposerFixture() {
        var chat = PhoneChat(id: "phone-parity", title: "On this iPhone", providerId: "fixture", modelId: "fixture", createdAt: 0)
        chat.messages = [PhoneMessage(id: "reply", role: .assistant,
            text: "# Markdown works\n\n**Bold**, _italic_, and `code`.\n\n- First item\n- Second item\n\n| Feature | State |\n| --- | --- |\n| Markdown | Ready |", at: 0)]
        chats = [chat]
    }
}
#endif
