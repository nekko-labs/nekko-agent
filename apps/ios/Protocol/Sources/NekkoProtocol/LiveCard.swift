import Foundation

// The one Live Activity card for all of the computer's chats. Pure state and
// rules; the views and ActivityKit lifecycle live in the app.

public enum LiveLevel: String, Codable, CaseIterable, Sendable {
    case none, minimal, standard, detailed
}

public enum LiveChatState: String, Codable, Sendable {
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

public struct LiveChat: Codable, Hashable, Sendable {
    public var id: String
    /// About 8 characters, for the chip (see `shortTitle`).
    public var short: String
    /// The chat's title for its row on the card, at most 40 characters (see
    /// `LiveCardRules.titleLength`). Empty at Minimal and from a computer that
    /// predates the rows: the row falls back to `short`, then to the phase line.
    public var title: String
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
    /// The waiting call is an MCP tool, so the card offers "Always allow this
    /// tool" (decision 0054). Left out of the state when false.
    public var alwaysAllow: Bool

    public init(id: String, short: String, state: LiveChatState, step: String, reply: String, closeWord: String,
                finishedAt: Date?, callId: String?, severity: String?, startedAt: Date? = nil, title: String = "",
                alwaysAllow: Bool = false) {
        self.id = id
        self.short = short
        self.title = title
        self.state = state
        self.step = step
        self.reply = reply
        self.closeWord = closeWord
        self.finishedAt = finishedAt
        self.callId = callId
        self.severity = severity
        self.startedAt = startedAt
        self.alwaysAllow = alwaysAllow
    }

    private enum CodingKeys: String, CodingKey {
        case id, short, title, state, step, reply, closeWord, finishedAt, startedAt, callId, severity, alwaysAllow
    }

    /// Pushes may omit anything but the id and state.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        short = try c.decodeIfPresent(String.self, forKey: .short) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        state = try c.decode(LiveChatState.self, forKey: .state)
        step = try c.decodeIfPresent(String.self, forKey: .step) ?? ""
        reply = try c.decodeIfPresent(String.self, forKey: .reply) ?? ""
        closeWord = try c.decodeIfPresent(String.self, forKey: .closeWord) ?? ""
        finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
        callId = try c.decodeIfPresent(String.self, forKey: .callId)
        severity = try c.decodeIfPresent(String.self, forKey: .severity)
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
        alwaysAllow = try c.decodeIfPresent(Bool.self, forKey: .alwaysAllow) ?? false
    }

    /// Written as the synthesized encoder would, except an empty title is left
    /// out, so a card without titles stays the size it was (and matches the
    /// fixture's byte counts, which the computer's builder shares).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(short, forKey: .short)
        if !title.isEmpty { try c.encode(title, forKey: .title) }
        try c.encode(state, forKey: .state)
        try c.encode(step, forKey: .step)
        try c.encode(reply, forKey: .reply)
        try c.encode(closeWord, forKey: .closeWord)
        try c.encodeIfPresent(finishedAt, forKey: .finishedAt)
        try c.encodeIfPresent(startedAt, forKey: .startedAt)
        try c.encodeIfPresent(callId, forKey: .callId)
        try c.encodeIfPresent(severity, forKey: .severity)
        if alwaysAllow { try c.encode(true, forKey: .alwaysAllow) }
    }
}

/// The ActivityKit `ContentState` of the card.
public struct LiveCardState: Codable, Hashable, Sendable {
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
    /// The encoded state's budget, under ActivityKit's 4 KB.
    public static let maxBytes = 3500
    /// A row's title, in characters.
    public static let titleLength = 40
    /// Chats the card draws as rows; the rest are counted by state below them.
    public static let rows = 2
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
        kept[i].step = Transcript.oneLine(kept[i].step, 60)
        kept[i].title = Transcript.oneLine(kept[i].title, LiveCardRules.titleLength)
        if level == .minimal { kept[i].short = ""; kept[i].title = ""; kept[i].step = "" }
        if level != .detailed { kept[i].reply = "" }
    }
    var card = LiveCardState(chats: kept, focusId: focus ?? pinned ?? kept[0].id, more: more,
                             listening: previous?.listening ?? false, heard: previous?.heard ?? "")
    // ActivityKit refuses a state over 4 KB (a request returns no card, an update is
    // dropped): replies go first, then the last chats move into "+N", never the focused one.
    func tooBig() -> Bool { ((try? JSONEncoder().encode(card))?.count ?? 0) > LiveCardRules.maxBytes }
    if tooBig() { for i in card.chats.indices { card.chats[i].reply = "" } }
    while tooBig(), let last = card.chats.lastIndex(where: { $0.id != card.focusId }) {
        card.chats.remove(at: last)
        card.more += 1
    }
    return card
}

/// The chats the card draws as rows: the first two (what needs you sorts
/// first), with the focused chat swapped into the second row when it sits
/// further down, so the buttons always answer a chat you can see.
public func cardRows(_ card: LiveCardState) -> [LiveChat] {
    var rows = Array(card.chats.prefix(LiveCardRules.rows))
    if let focus = card.focusId, !rows.contains(where: { $0.id == focus }),
       let chat = card.chats.first(where: { $0.id == focus }) {
        rows[rows.count - 1] = chat
    }
    return rows
}

/// The count line under the rows: the chats that are not rows, by state in the
/// card's order ("3 working, 5 done"), and the chats past the eight the state
/// carries, whose state the card does not know (`more`).
public func cardTally(_ card: LiveCardState) -> CardTally {
    let shown = Set(cardRows(card).map(\.id))
    var counts: [LiveChatState: Int] = [:]
    for chat in card.chats where !shown.contains(chat.id) { counts[chat.state, default: 0] += 1 }
    let states = counts.sorted { $0.key.rank < $1.key.rank }.map { CardTally.Count(state: $0.key, count: $0.value) }
    return CardTally(states: states, more: card.more)
}

public struct CardTally: Equatable, Sendable {
    public struct Count: Hashable, Sendable {
        public var state: LiveChatState
        public var count: Int
        public init(state: LiveChatState, count: Int) {
            self.state = state
            self.count = count
        }
    }

    public var states: [Count]
    public var more: Int
    public var isEmpty: Bool { states.isEmpty && more == 0 }

    public init(states: [Count], more: Int) {
        self.states = states
        self.more = more
    }
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

/// The card's reply line (Detailed): the first sentence of the agent's latest
/// reply, or its first line, at most 60 characters.
public func replyLine(_ text: String?) -> String {
    let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var end = t.endIndex
    for i in t.indices {
        if t[i].isNewline { end = i; break }
        let next = t.index(after: i)
        if ".!?".contains(t[i]), next == t.endIndex || t[next].isWhitespace { end = next; break }
    }
    let line = t[..<end].trimmingCharacters(in: .whitespaces)
    return line.count > 60 ? line.prefix(59).trimmingCharacters(in: .whitespaces) + "…" : line
}
