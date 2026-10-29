import Foundation
import NekkoProtocol
import Observation

/// Where the phone keeps what it must not lose while the computer is out of
/// reach: each computer's drafts and outbox, one small JSON file each. The app
/// stores them under Application Support, encrypted until the iPhone is first
/// unlocked, left out of backups and deleted with Forget; tests use memory.
@MainActor
public protocol OfflineFiles: AnyObject {
    func load(_ computerId: String, _ name: String) -> JSONValue?
    func save(_ computerId: String, _ name: String, _ value: JSONValue)
    /// Forget: every file of this computer.
    func remove(_ computerId: String)
}

/// What a composer holds before it is sent: a chat's, or New chat's (which
/// also keeps its model, folder and tool policy). Photos are the
/// already-scaled JPEG data URLs the computer receives.
public struct Draft: Equatable, Sendable {
    public var text: String
    public var skill: SkillSummary?
    public var images: [String]
    /// New chat only: the model, folder and tool policy picked for it.
    public var providerId: String?
    public var modelId: String?
    public var workspaceId: String?
    public var mode: String?
    public var effort: String?
    /// Why the computer turned this prompt down, when it came back from the outbox.
    public var refusal: String?

    public init(text: String = "", skill: SkillSummary? = nil, images: [String] = [], providerId: String? = nil,
                modelId: String? = nil, workspaceId: String? = nil, mode: String? = nil, effort: String? = nil, refusal: String? = nil) {
        self.text = text
        self.skill = skill
        self.images = images
        self.providerId = providerId
        self.modelId = modelId
        self.workspaceId = workspaceId
        self.mode = mode
        self.effort = effort
        self.refusal = refusal
    }

    /// Nothing worth keeping: no words, skill or photos, and no New chat choices.
    public var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && skill == nil && images.isEmpty
            && providerId == nil && modelId == nil && workspaceId == nil && mode == nil && effort == nil && refusal == nil
    }

    /// Something to send: words, a skill or a photo.
    public var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skill != nil || !images.isEmpty
    }

    /// `back` (a prompt the computer refused) put in front of what is typed now, so neither is lost.
    public func merging(_ back: Draft) -> Draft {
        var out = self
        let mine = text.trimmingCharacters(in: .whitespacesAndNewlines)
        out.text = mine.isEmpty ? back.text : back.text + "\n\n" + text
        out.skill = skill ?? back.skill
        out.images = Array((back.images + images).prefix(Draft.maxImages))
        out.providerId = providerId ?? back.providerId
        out.modelId = modelId ?? back.modelId
        out.workspaceId = workspaceId ?? back.workspaceId
        out.mode = mode ?? back.mode
        out.effort = effort ?? back.effort
        out.refusal = back.refusal ?? refusal
        return out
    }

    /// As many photos as one prompt takes (the composer's picker limit).
    public static let maxImages = 4

    var json: JSONValue {
        var o: [String: JSONValue] = ["text": .string(text)]
        if let skill { o["skill"] = skill.json }
        if !images.isEmpty { o["images"] = .array(images.map { .string($0) }) }
        if let providerId { o["providerId"] = .string(providerId) }
        if let modelId { o["modelId"] = .string(modelId) }
        if let workspaceId { o["workspaceId"] = .string(workspaceId) }
        if let mode { o["mode"] = .string(mode) }
        if let effort { o["effort"] = .string(effort) }
        if let refusal { o["refusal"] = .string(refusal) }
        return .object(o)
    }

    static func from(_ v: JSONValue?) -> Draft? {
        guard let v, v.object != nil else { return nil }
        return Draft(text: v.str("text") ?? "", skill: SkillSummary.from(v["skill"]),
                     images: v["images"]?.array?.compactMap(\.string) ?? [], providerId: v.str("providerId"),
                     modelId: v.str("modelId"), workspaceId: v.str("workspaceId"), mode: v.str("mode"),
                     effort: v.str("effort"), refusal: v.str("refusal"))
    }
}

extension SkillSummary {
    var json: JSONValue {
        .object(["name": .string(name), "description": .string(description), "category": .string(category), "source": .string(source)])
    }

    static func from(_ v: JSONValue?) -> SkillSummary? {
        guard let v, let name = v.str("name"), !name.isEmpty else { return nil }
        return SkillSummary(name: name, description: v.str("description") ?? "", category: v.str("category") ?? "", source: v.str("source") ?? "")
    }
}

/// The active computer's drafts: one per chat, plus New chat's under
/// `DraftStore.newChat`. Saved to disk shortly after each edit (and at once
/// when one is cleared or the app leaves the screen), so a draft survives
/// navigating away and iOS ending the app. A draft is cleared only when its
/// prompt moves to the outbox, which is saved first.
@MainActor
@Observable
public final class DraftStore {
    nonisolated public static let newChat = "new"
    static let file = "drafts"
    /// Bumped when the shape changes; an older or newer file is ignored, not misread.
    static let version: Int64 = 1

    public private(set) var drafts: [String: Draft] = [:]
    private var computerId: String?
    private let files: OfflineFiles?
    private let debounce: TimeInterval
    private var saveTask: Task<Void, Never>?

    public init(files: OfflineFiles?, debounce: TimeInterval = 0.5) {
        self.files = files
        self.debounce = debounce
    }

    /// Show `computerId`'s drafts (saving the previous computer's first).
    public func load(_ computerId: String?) {
        flush()
        self.computerId = computerId
        guard let computerId, let v = files?.load(computerId, Self.file), v.long("v") == Self.version else {
            drafts = [:]
            return
        }
        var out: [String: Draft] = [:]
        for (key, d) in v["drafts"]?.object ?? [:] {
            if let d = Draft.from(d), !d.isEmpty { out[key] = d }
        }
        drafts = out
    }

    public func draft(_ key: String) -> Draft { drafts[key] ?? Draft() }

    /// Keep what the composer holds now; saved after a short pause in typing.
    public func set(_ key: String, _ draft: Draft) {
        let next: Draft? = draft.isEmpty ? nil : draft
        guard drafts[key] != next else { return }
        drafts[key] = next
        scheduleSave()
    }

    /// The prompt was sent (it is in the outbox now), or the user cleared it.
    public func clear(_ key: String) {
        guard drafts[key] != nil else { return }
        drafts[key] = nil
        flush()
    }

    /// A prompt the computer refused comes back, in front of anything typed since.
    public func handBack(_ key: String, _ back: Draft) {
        drafts[key] = draft(key).merging(back)
        flush()
    }

    /// Move a draft to another key (a chat created from New chat got its id).
    public func move(from: String, to: String) {
        guard let d = drafts.removeValue(forKey: from) else { return }
        drafts[to] = (drafts[to] ?? Draft()).merging(d)
        flush()
    }

    /// Write now: the app is going to the background, or the computer changes.
    public func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard let computerId, let files else { return }
        files.save(computerId, Self.file, .object([
            "v": .int(Self.version),
            "drafts": .object(drafts.mapValues(\.json)),
        ]))
    }

    private func scheduleSave() {
        saveTask?.cancel()
        let delay = debounce
        saveTask = Task { @MainActor [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }
}
