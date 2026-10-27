import Foundation

// The one Live Activity card for all of the computer's chats. Pure state and
// rules; the views and ActivityKit lifecycle live in the app.

public enum LiveLevel: String, Codable, CaseIterable {
    case none, minimal, standard, detailed
}

public enum LiveChatState: String, Codable {
    case needsYou, working, watching, done, failed

    /// A state from a newer computer reads as working, rather than failing the whole card.
    public init(from decoder: Decoder) throws {
        self = LiveChatState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .working
    }

    /// Sort order on the card: what needs you first.
    var rank: Int {
        switch self {
        case .needsYou: return 0
        case .working: return 1
        case .watching: return 2
        case .done: return 3
        case .failed: return 4
        }
    }
}

public struct LiveChat: Codable, Hashable {
    public var id: String
    /// About 8 characters, for the chip (see `shortTitle`).
    public var short: String
    public var state: LiveChatState
    public var step: String
    /// The agent's latest reply line (Detailed only).
    public var reply: String
    /// The label of the close button once the chat is finished (see `closeWord`).
    public var closeWord: String
    public var finishedAt: Date?
    /// When the current run started, for the elapsed time (working or needs you).
    public var startedAt: Date?
    /// The tool call waiting for approval, so the buttons can answer it.
    public var callId: String?
    /// low / medium / high (the computer's guardrail rating).
    public var severity: String?

    public init(id: String, short: String, state: LiveChatState, step: String, reply: String, closeWord: String,
                finishedAt: Date?, callId: String?, severity: String?, startedAt: Date? = nil) {
        self.id = id
        self.short = short
        self.state = state
        self.step = step
        self.reply = reply
        self.closeWord = closeWord
        self.finishedAt = finishedAt
        self.callId = callId
        self.severity = severity
        self.startedAt = startedAt
    }

    /// Pushes may omit anything but the id and state.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        short = try c.decodeIfPresent(String.self, forKey: .short) ?? ""
        state = try c.decode(LiveChatState.self, forKey: .state)
        step = try c.decodeIfPresent(String.self, forKey: .step) ?? ""
        reply = try c.decodeIfPresent(String.self, forKey: .reply) ?? ""
        closeWord = try c.decodeIfPresent(String.self, forKey: .closeWord) ?? ""
        finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
        callId = try c.decodeIfPresent(String.self, forKey: .callId)
        severity = try c.decodeIfPresent(String.self, forKey: .severity)
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
    }
}

/// The ActivityKit `ContentState` of the card.
public struct LiveCardState: Codable, Hashable {
    public var chats: [LiveChat]
    public var focusId: String?
    /// Chats past the eight the state carries.
    public var more: Int
    public var listening: Bool
    /// What the mic heard so far.
    public var heard: String

    public init(chats: [LiveChat], focusId: String?, more: Int, listening: Bool, heard: String) {
        self.chats = chats
        self.focusId = focusId
        self.more = more
        self.listening = listening
        self.heard = heard
    }

    /// Pushes from the relay may leave fields out; they fall back to empty.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chats = try c.decodeIfPresent([LiveChat].self, forKey: .chats) ?? []
        focusId = try c.decodeIfPresent(String.self, forKey: .focusId)
        more = try c.decodeIfPresent(Int.self, forKey: .more) ?? 0
        listening = try c.decodeIfPresent(Bool.self, forKey: .listening) ?? false
        heard = try c.decodeIfPresent(String.self, forKey: .heard) ?? ""
    }
}

public enum LiveCardRules {
    public static let maxChats = 8
    /// A finished chat stays on the card this long.
    public static let finishedTail: TimeInterval = 2 * 3600
}

/// Builds the card from every chat, or nil when there is nothing to show
/// (no chats left, or the level is None).
public func buildCard(chats: [LiveChat], previous: LiveCardState?, pinnedFocus: String?, level: LiveLevel, now: Date) -> LiveCardState? {
    guard level != .none else { return nil }
    let live = chats.enumerated().filter { _, c in
        guard c.state == .done || c.state == .failed, let at = c.finishedAt else { return true }
        return now.timeIntervalSince(at) <= LiveCardRules.finishedTail
    }
    // Most recent first within a state; ties keep the caller's order.
    let sorted = live.sorted { a, b in
        if a.element.state.rank != b.element.state.rank { return a.element.state.rank < b.element.state.rank }
        let ta = a.element.finishedAt ?? .distantPast, tb = b.element.finishedAt ?? .distantPast
        return ta != tb ? ta > tb : a.offset < b.offset
    }.map(\.element)
    guard !sorted.isEmpty else { return nil }

    var kept = Array(sorted.prefix(LiveCardRules.maxChats))
    let more = sorted.count - kept.count

    let before = Dictionary((previous?.chats ?? []).map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
    let focus = previous != nil ? kept.first { $0.state == .needsYou && before[$0.id] != .needsYou }?.id : nil
    let pinned = pinnedFocus.flatMap { id in kept.contains { $0.id == id } ? id : nil }

    for i in kept.indices {
        if level == .minimal { kept[i].short = ""; kept[i].step = "" }
        if level != .detailed { kept[i].reply = "" }
    }
    return LiveCardState(chats: kept, focusId: focus ?? pinned ?? kept[0].id, more: more,
                         listening: previous?.listening ?? false, heard: previous?.heard ?? "")
}

/// The first word, plus the second when both fit in 8 characters; a longer
/// first word is cut to 8 and ends in "…".
public func shortTitle(_ title: String) -> String {
    let words = title.split(whereSeparator: \.isWhitespace).map(String.init)
    guard let first = words.first else { return "" }
    if first.count > 8 { return String(first.prefix(8)) + "…" }
    if words.count > 1, first.count + 1 + words[1].count <= 8 { return first + " " + words[1] }
    return first
}

private let closeWords = ["Looks good", "Cool", "Excellent", "Nice", "Perfect"]

/// "Got it" for a failure, else one of five friendly words picked by a hash of
/// the id (FNV-1a, not `hashValue`, which differs on every launch).
public func closeWord(for id: String, failed: Bool) -> String {
    if failed { return "Got it" }
    var h: UInt32 = 2166136261
    for b in id.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
    return closeWords[Int(h % UInt32(closeWords.count))]
}
