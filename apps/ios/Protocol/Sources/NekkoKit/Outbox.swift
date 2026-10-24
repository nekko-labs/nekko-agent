import Foundation
import NekkoProtocol
import Observation

/// The model, folder, tool policy and effort of a chat started while the computer was out of reach.
public struct NewChatSpec: Equatable, Sendable {
    public let providerId: String
    public let modelId: String
    public let workspaceId: String?
    public let mode: String?
    public let effort: String?

    public init(providerId: String, modelId: String, workspaceId: String? = nil, mode: String? = nil, effort: String? = nil) {
        self.providerId = providerId
        self.modelId = modelId
        self.workspaceId = workspaceId
        self.mode = mode
        self.effort = effort
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["providerId": .string(providerId), "modelId": .string(modelId)]
        if let workspaceId { o["workspaceId"] = .string(workspaceId) }
        if let mode { o["mode"] = .string(mode) }
        if let effort { o["effort"] = .string(effort) }
        return .object(o)
    }

    static func from(_ v: JSONValue?) -> NewChatSpec? {
        guard let v, let p = v.str("providerId"), let m = v.str("modelId") else { return nil }
        return NewChatSpec(providerId: p, modelId: m, workspaceId: v.str("workspaceId"), mode: v.str("mode"), effort: v.str("effort"))
    }
}

/// A prompt written while the computer was out of reach (or whose send
/// dropped), waiting to be delivered. Its `id` is the `clientMessageId` the
/// computer remembers, so sending it again after a lost answer never runs it twice.
public struct OutboxItem: Equatable, Sendable, Identifiable {
    public let id: String
    /// The chat it goes to: its id, or `new-<id>` for a chat started offline until the computer creates it.
    public let chatKey: String
    /// The chat's id on the computer; nil only for a new chat not created yet.
    public var chatId: String?
    public var text: String
    public var skill: SkillSummary?
    public var images: [String]
    /// Set for a chat started offline: what to create it with.
    public var newChat: NewChatSpec?
    public let createdAt: Int64
    /// Why the last try didn't get through (it is tried again); nil before any try.
    public var lastError: String?

    public init(id: String, chatKey: String, chatId: String?, text: String, skill: SkillSummary? = nil, images: [String] = [],
                newChat: NewChatSpec? = nil, createdAt: Int64, lastError: String? = nil) {
        self.id = id
        self.chatKey = chatKey
        self.chatId = chatId
        self.text = text
        self.skill = skill
        self.images = images
        self.newChat = newChat
        self.createdAt = createdAt
        self.lastError = lastError
    }

    /// The prompt as one line, as the transcript and the chat list show it.
    public var preview: String {
        let t = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if let skill { return "/\(skill.name)" + (t.isEmpty ? "" : " \(t)") }
        if t.isEmpty { return images.count == 1 ? "1 photo" : "\(images.count) photos" }
        return t
    }

    /// The draft this prompt becomes when it is taken back (Edit) or refused.
    func asDraft(refusal: String? = nil) -> Draft {
        Draft(text: text, skill: skill, images: images, providerId: chatId == nil ? newChat?.providerId : nil,
              modelId: chatId == nil ? newChat?.modelId : nil, workspaceId: chatId == nil ? newChat?.workspaceId : nil,
              mode: chatId == nil ? newChat?.mode : nil, effort: chatId == nil ? newChat?.effort : nil, refusal: refusal)
    }

    /// Where that draft goes: the chat's composer, or New chat's while the chat doesn't exist.
    var draftKey: String { chatId ?? DraftStore.newChat }

    var json: JSONValue {
        var o: [String: JSONValue] = ["id": .string(id), "chatKey": .string(chatKey), "text": .string(text), "createdAt": .int(createdAt)]
        if let chatId { o["chatId"] = .string(chatId) }
        if let skill { o["skill"] = skill.json }
        if !images.isEmpty { o["images"] = .array(images.map { .string($0) }) }
        if let newChat { o["newChat"] = newChat.json }
        if let lastError { o["lastError"] = .string(lastError) }
        return .object(o)
    }

    static func from(_ v: JSONValue) -> OutboxItem? {
        guard let id = v.str("id"), let key = v.str("chatKey") else { return nil }
        let item = OutboxItem(id: id, chatKey: key, chatId: v.str("chatId"), text: v.str("text") ?? "",
                              skill: SkillSummary.from(v["skill"]), images: v["images"]?.array?.compactMap(\.string) ?? [],
                              newChat: NewChatSpec.from(v["newChat"]), createdAt: v.long("createdAt") ?? 0,
                              lastError: v.str("lastError"))
        // Nowhere to deliver it: kept out rather than tried forever.
        return item.chatId == nil && item.newChat == nil ? nil : item
    }
}

/// One computer's outbox: prompts written offline (or whose send dropped),
/// saved to disk the moment they are added and delivered in order, one at a
/// time, when the computer is reachable again (on connect, on return to the
/// foreground, on a network change). A chat that is running gets the prompt
/// in its queue. Each prompt carries its `clientMessageId`, and it leaves the
/// outbox only when the computer's copy of the chat lists that id, so a
/// connection lost mid-send means "send again", never "maybe lost" or "twice".
/// When the computer refuses one (chat deleted, no model, …) it goes back to
/// its draft with the reason. Approvals and question answers are never queued.
@MainActor
@Observable
public final class Outbox {
    static let file = "outbox"
    static let version: Int64 = 1

    public private(set) var items: [OutboxItem] = []
    /// The prompt being delivered now: its Edit and Delete wait until it is settled.
    public private(set) var sendingId: String?
    public private(set) var flushing = false
    /// Prompts an open chat is sending itself right now. They are on disk like
    /// the rest (a crash mid-send loses nothing) but not shown as waiting, and
    /// the outbox leaves them alone unless the send drops (`endDirect`).
    public private(set) var direct: Set<String> = []
    /// Chats started offline that the computer has created: their `chatKey` → the chat's id.
    public private(set) var created: [String: String] = [:]
    /// Called after each delivery, with the chat's id.
    public var onDelivered: ((OutboxItem, String) -> Void)?

    private var computerId: String?
    private let files: OfflineFiles?
    private let drafts: DraftStore
    private let caller: () -> Caller?
    private let defaults: () -> RemoteDefaults
    private let newIdFn: () -> String
    private let now: () -> Int64
    let pollInterval: TimeInterval
    let confirmTimeout: TimeInterval
    /// The last `error` event per chat: the reason a `chat:send` the computer answered was not taken.
    private var lastErrors: [String: String] = [:]

    public init(files: OfflineFiles?, drafts: DraftStore, caller: @escaping () -> Caller?,
                defaults: @escaping () -> RemoteDefaults = { RemoteDefaults() },
                newId: @escaping () -> String = { UUID().uuidString.lowercased() },
                now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
                pollInterval: TimeInterval = 0.5, confirmTimeout: TimeInterval = 45) {
        self.files = files
        self.drafts = drafts
        self.caller = caller
        self.defaults = defaults
        self.newIdFn = newId
        self.now = now
        self.pollInterval = pollInterval
        self.confirmTimeout = confirmTimeout
    }

    public func newId() -> String { newIdFn() }

    // MARK: Reading

    /// What waits to be delivered (not what an open chat is sending right now).
    public var waiting: [OutboxItem] { items.filter { !direct.contains($0.id) } }

    public var count: Int { waiting.count }

    /// The prompts waiting for one chat (its id, or a new chat's key), oldest first.
    public func items(for chat: String) -> [OutboxItem] {
        waiting.filter { $0.chatKey == chat || $0.chatId == chat }
    }

    public func count(for chat: String) -> Int { items(for: chat).count }

    /// Chats started offline that the computer hasn't created yet.
    public var pendingNewChats: [OutboxItem] {
        var seen = Set<String>()
        return items.filter { $0.chatId == nil && seen.insert($0.chatKey).inserted }
    }

    // MARK: Changing

    /// Show `computerId`'s outbox.
    public func load(_ computerId: String?) {
        self.computerId = computerId
        created = [:]
        lastErrors = [:]
        direct = []
        guard let computerId, let v = files?.load(computerId, Self.file), v.long("v") == Self.version else {
            items = []
            return
        }
        items = (v["items"]?.array ?? []).compactMap(OutboxItem.from)
    }

    /// Put a prompt in the outbox, saved before this returns. `chatId` nil
    /// with `newChat` starts a chat there once the computer is back.
    @discardableResult
    public func add(chatId: String?, text: String, skill: SkillSummary? = nil, images: [String] = [],
                    newChat: NewChatSpec? = nil, id: String? = nil, direct: Bool = false) -> OutboxItem {
        let id = id ?? newId()
        if !direct { self.direct.remove(id) }
        if let existing = items.first(where: { $0.id == id }) { return existing }
        if direct { self.direct.insert(id) }
        let item = OutboxItem(id: id, chatKey: chatId ?? "new-\(id)", chatId: chatId, text: text, skill: skill,
                              images: images, newChat: chatId == nil ? newChat : nil, createdAt: now())
        items.append(item)
        save()
        return item
    }

    /// The open chat's send of `id` got no answer: it waits like any other now.
    public func endDirect(_ id: String) {
        direct.remove(id)
    }

    /// The computer's copy of `chatId` lists these ids: those prompts were delivered.
    public func confirm(_ chatId: String, _ ids: [String]) {
        let done = Set(ids)
        guard items.contains(where: { $0.chatId == chatId && done.contains($0.id) && $0.id != sendingId }) else { return }
        items.removeAll { $0.chatId == chatId && done.contains($0.id) && $0.id != sendingId }
        direct.subtract(done)
        save()
    }

    /// The computer refused the open chat's send: it goes back to the composer from there, not from here.
    public func drop(_ id: String) {
        direct.remove(id)
        guard items.contains(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        save()
    }

    /// Delete: the prompt is dropped. False while it is being delivered.
    @discardableResult
    public func remove(_ id: String) -> Bool {
        guard sendingId != id, !direct.contains(id), items.contains(where: { $0.id == id }) else { return false }
        items.removeAll { $0.id == id }
        save()
        return true
    }

    /// Edit: the prompt goes back to its composer's draft (in front of anything
    /// typed there). Returns the draft's key, or nil while it is being delivered.
    @discardableResult
    public func takeBack(_ id: String) -> String? {
        guard sendingId != id, !direct.contains(id), let item = items.first(where: { $0.id == id }) else { return nil }
        drafts.handBack(item.draftKey, item.asDraft())
        items.removeAll { $0.id == id }
        save()
        return item.draftKey
    }

    /// Every prompt back to its draft, with why (this phone was unpaired).
    public func handBackAll(reason: String) {
        guard !items.isEmpty else { return }
        for item in items where item.id != sendingId { drafts.handBack(item.draftKey, item.asDraft(refusal: reason)) }
        items.removeAll { $0.id != sendingId }
        direct = []
        save()
    }

    /// The computer's events: an `error` for a chat is the reason a send was turned down.
    public func onEvent(_ e: AgentEvent) {
        if case .error(let sid, let message) = e { lastErrors[sid] = message }
    }

    // MARK: Delivering

    enum Outcome: Equatable {
        case delivered(String)
        case refused(String)
        /// It didn't get through (no connection, no answer yet): try again later.
        case later(String)
        /// Try again now (the chat started running: it goes in the queue).
        case again
    }

    /// Deliver what is waiting, oldest first, one at a time. Stops at the first
    /// prompt that can't get through now; the next connect, foreground or
    /// network change tries again.
    public func flush() async {
        guard !flushing, !waiting.isEmpty, let c = caller() else { return }
        flushing = true
        defer {
            flushing = false
            sendingId = nil
        }
        var again = 0
        while let item = items.first(where: { !direct.contains($0.id) }) {
            guard caller() === c else { return }
            sendingId = item.id
            let outcome = await deliver(item, c)
            switch outcome {
            case .delivered(let chatId):
                // As it was last saved (with any note from delivering it).
                let current = items.first { $0.id == item.id } ?? item
                items.removeAll { $0.id == item.id }
                save()
                onDelivered?(current, chatId)
            case .refused(let reason):
                let current = items.first { $0.id == item.id } ?? item
                drafts.handBack(current.draftKey, current.asDraft(refusal: reason))
                items.removeAll { $0.id == item.id }
                save()
            case .again where again < 2:
                again += 1
                continue
            case .again:
                update(item.id) { $0.lastError = "Your computer is busy with this chat. It will be sent when it’s free." }
                return
            case .later(let why):
                update(item.id) { $0.lastError = why }
                return
            }
            again = 0
        }
    }

    private func deliver(_ item: OutboxItem, _ c: Caller) async -> Outcome {
        var chatId = item.chatId
        if chatId == nil {
            guard let spec = item.newChat else { return .refused("This prompt has no chat to go to.") }
            do {
                let made = try await c.call(Channels.sessionCreate, spec.workspaceId.map { [.string($0)] } ?? [])
                guard let s = Session.from(made) else { return .refused("Your computer didn’t create the chat.") }
                // Saved before anything else, so trying again never makes a second chat.
                update(item.id) { $0.chatId = s.id }
                for i in items.indices where items[i].chatKey == item.chatKey { items[i].chatId = s.id }
                save()
                created[item.chatKey] = s.id
                drafts.move(from: item.chatKey, to: s.id)
                chatId = s.id
            } catch {
                return Self.outcome(error)
            }
        }
        guard let chatId else { return .refused("This prompt has no chat to go to.") }
        do {
            if let spec = item.newChat {
                // A chat started offline: its model and tool policy (again on a retry, which changes nothing).
                var o: [String: JSONValue] = ["providerId": .string(spec.providerId), "modelId": .string(spec.modelId)]
                if let mode = spec.mode { o["mode"] = .string(mode) }
                if let effort = spec.effort { o["effort"] = .string(effort) }
                do {
                    _ = try await c.call(Channels.sessionSetOptions, [.string(chatId), .object(o)])
                } catch let e as RelayError where e.fromComputer && o["mode"] != nil
                    && PhoneRefusal(e.message)?.code == "proof-required" {
                    // A mode above the computer's default needs Face ID, which a
                    // prompt sent from the queue can't ask for: it goes out under
                    // the computer's default mode instead, and says so.
                    o["mode"] = nil
                    _ = try await c.call(Channels.sessionSetOptions, [.string(chatId), .object(o)])
                    update(item.id) { $0.lastError = Self.modeNotRaised }
                }
            }
            guard let session = Session.from(try await c.call(Channels.sessionGet, [.string(chatId)])) else {
                return .refused("This chat was deleted on your computer.")
            }
            // Sent before (the answer was lost): delivered.
            if session.clientMessageIds.contains(item.id) { return .delivered(chatId) }
            if session.running {
                let queued = Session.from(try await c.call(Channels.chatQueue, [
                    .string(chatId),
                    queuePrompt(text: item.text, skill: item.skill, images: item.images, clientMessageId: item.id),
                ]))
                if queued?.clientMessageIds.contains(item.id) == true { return .delivered(chatId) }
                return .refused(queued == nil ? "This chat was deleted on your computer." : "Your computer didn’t take this prompt.")
            }
            // A chat started offline runs on the model picked for it; any other on its own, else the default.
            let (p, m) = item.newChat.map { ($0.providerId, $0.modelId) } ?? ChatModel.resolveModel(session, defaults())
            guard let p, let m else { return .refused("No model chosen for this chat. Set a default model on your computer.") }
            lastErrors[chatId] = nil
            let opts = sendOptions(sessionId: chatId, providerId: p, modelId: m, text: item.text, skill: item.skill,
                                   images: item.images, clientMessageId: item.id)
            // `chat:send` answers when the whole turn ends (maybe hours): the
            // prompt counts as delivered once the chat lists its id.
            let send = SendWatch()
            Task { @MainActor in
                do {
                    _ = try await c.call(Channels.chatSend, [opts], timeout: turnTimeout)
                    send.finish(nil)
                } catch {
                    send.finish(error)
                }
            }
            var waited: TimeInterval = 0
            while true {
                try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1e9))
                waited += pollInterval
                let finished = send.done
                do {
                    let s = Session.from(try await c.call(Channels.sessionGet, [.string(chatId)]))
                    if s?.clientMessageIds.contains(item.id) == true { return .delivered(chatId) }
                    if s == nil { return .refused("This chat was deleted on your computer.") }
                } catch {
                    if !finished { return Self.outcome(error) }
                }
                if finished {
                    guard let error = send.error else {
                        // Answered, and the chat doesn't have it: the computer turned it down.
                        return .refused(lastErrors[chatId] ?? "Your computer didn’t start this prompt.")
                    }
                    if let r = error as? RelayError, r.fromComputer, r.message.localizedCaseInsensitiveContains("already") {
                        return .again
                    }
                    return Self.outcome(error)
                }
                if waited >= confirmTimeout { return .later("No answer from your computer yet.") }
            }
        } catch {
            return Self.outcome(error)
        }
    }

    /// A refusal when the computer answered with an error; otherwise try again later.
    static func outcome(_ error: Error) -> Outcome {
        if let r = error as? RelayError, r.fromComputer {
            return .refused(isOldComputer(r) ? needsUpdate : r.message)
        }
        return .later(error.localizedDescription)
    }

    /// A computer from before exactly-once delivery refuses `clientMessageId`.
    /// The outbox never sends without it (a resend could run twice): the
    /// prompt goes back to its draft, saying why.
    public static func isOldComputer(_ e: RelayError) -> Bool {
        e.fromComputer && e.message.contains("clientMessageId")
    }

    static let needsUpdate = "Update Nekko Agent on your computer to send prompts written offline. Send it again from here."

    /// A chat started offline asked for fewer approvals than the computer's default.
    public static let modeNotRaised = "Sent with your computer’s default approvals: allowing fewer needs Face ID, which a queued prompt can’t ask for. Change it in the chat."

    private func update(_ id: String, _ change: (inout OutboxItem) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
        save()
    }

    private func save() {
        guard let computerId, let files else { return }
        files.save(computerId, Self.file, .object(["v": .int(Self.version), "items": .array(items.map(\.json))]))
    }
}

/// How a `chat:send` started by the outbox ended, read while it runs.
@MainActor
final class SendWatch {
    private(set) var done = false
    private(set) var error: Error?

    func finish(_ error: Error?) {
        done = true
        self.error = error
    }
}
