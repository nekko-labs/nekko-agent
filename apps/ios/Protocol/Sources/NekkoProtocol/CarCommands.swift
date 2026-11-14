import Foundation

// What the driver says to Nekko in CarPlay, and which chat a spoken name means.
// Pure rules, no audio: the car session (NekkoKit/CarSession) acts on them.
// Unlike the composer's grammar (VoiceCommands.swift) there is no wake word: the
// driver tapped Talk, so every utterance is addressed to Nekko. A leading
// "Nekko," is allowed and dropped.

public enum CarCommand: Equatable, Sendable {
    /// "status", "what's happening", "what needs me".
    case status
    /// "read Billing", "what did Billing say"; nil names the chat Talk was opened in.
    case read(chat: String?)
    /// "tell Billing to run the tests"; nil chat inside a chat's Talk.
    case tell(chat: String?, message: String)
    case allow(chat: String?)
    case deny(chat: String?)
    case stop(chat: String?)
    /// "start a chat to look into the flaky test".
    case newChat(message: String)
    case yes, no
    /// "the first one", "second", "3".
    case pick(Int)
    /// "say that again", "repeat".
    case again
    case unknown(String)
}

private func rx(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) }

private func groups(_ re: NSRegularExpression, _ s: String) -> [String]? {
    guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
    return (0..<m.numberOfRanges).map { Range(m.range(at: $0), in: s).map { String(s[$0]) } ?? "" }
}

private let wake = rx(#"^(?:hey |ok |okay )?ne[ck][ck]?o\b[\s,:.!?-]*"#)
private let trailing = rx(#"[\s.!?,]+$"#)
private let carStatus = rx(#"^(?:status|what(?:'s| is) (?:happening|going on|the status)|how(?:'s| is| are) (?:it|things|everything) going|what needs (?:me|my attention)|(?:does )?anything need me|any updates?|catch me up|give me (?:a |the )?(?:status|summary|rundown))$"#)
private let carYes = rx(#"^(?:yes|yeah|yep|yup|sure|confirm|do it|go ahead|send it|ok|okay|correct|please do|yes please)$"#)
private let carNo = rx(#"^(?:no|nope|cancel|never ?mind|stop listening|forget it|don't|do not|no thanks)$"#)
private let carAgain = rx(#"^(?:say (?:that|it) again|repeat(?: that)?|again|what\??|come again|pardon)$"#)
private let carPick = rx(#"^(?:the )?(first|second|third|one|two|three|1|2|3|1st|2nd|3rd)(?: one)?$"#)
private let readRe = rx(#"^(?:read(?: me)?(?: the latest(?: from| in)?| the reply(?: from| in)?)?|what did|what does|what has|what's|catch me up on|any news (?:from|on)|what's new (?:in|with|on))\s+(.+?)(?:\s+(?:say|said|saying|reply|replied|have to say|got to say|up to))?$"#)
private let readHere = rx(#"^(?:read (?:it|that|the (?:latest|reply))(?: again)?|what did (?:it|they) say|read me the latest)$"#)
private let tellRe = rx(#"^(?:tell|ask|message|reply to|send to|send)\s+(.+?)(?:\s*[:,]\s*|\s+(?:saying|that|to)\s+)(.+)$"#)
private let allowRe = rx(#"^(?:allow|approve|accept|let it|let (?:it|them) run|go ahead with)(?:\s+(?:it|that|this))?(?:\s+(?:on|in|for))?(?:\s+(.+))?$"#)
private let denyRe = rx(#"^(?:deny|reject|decline|don't allow|do not allow|block)(?:\s+(?:it|that|this))?(?:\s+(?:on|in|for))?(?:\s+(.+))?$"#)
private let stopRe = rx(#"^(?:stop|halt|abort|cancel)\s+(?:the\s+)?(?:work (?:on|in)\s+)?(.+)$"#)
private let stopHere = rx(#"^(?:stop|halt|abort)(?: it| that| this| working| the work)?$"#)
private let newRe = rx(#"^(?:start|open|create|make|begin)(?: a| an)?(?: new)? (?:chat|agent|session|task)(?:\s+(?:to|that|which|about|and|for|on|:|,))?\s*(.+)$"#)
private let newRe2 = rx(#"^new (?:chat|agent|session|task)(?:\s*[:,]|\s+(?:to|about|for))?\s+(.+)$"#)

private let ordinals: [String: Int] = ["first": 1, "one": 1, "1": 1, "1st": 1, "second": 2, "two": 2, "2": 2, "2nd": 2, "third": 3, "three": 3, "3": 3, "3rd": 3]

private func strip(_ re: NSRegularExpression, _ s: String) -> String {
    re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
}

/// What one utterance means. `inChat`: Talk was opened on a chat's screen, so
/// anything that is not a command is a message to that chat.
public func parseCarCommand(_ text: String, inChat: Bool = false) -> CarCommand {
    let said = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\u{2019}", with: "'")
    let addressed = strip(wake, said)
    let original = strip(trailing, addressed).trimmingCharacters(in: .whitespacesAndNewlines)
    let c = original.lowercased()
    guard !c.isEmpty else { return .unknown(said) }

    if groups(carYes, c) != nil { return .yes }
    if groups(carNo, c) != nil { return .no }
    if groups(carAgain, c) != nil { return .again }
    if let g = groups(carPick, c), let n = ordinals[g[1]] { return .pick(n) }
    if groups(carStatus, c) != nil { return .status }
    if groups(readHere, c) != nil { return .read(chat: nil) }
    if groups(stopHere, c) != nil { return .stop(chat: nil) }
    // New chat before tell: "start a chat to ..." must not read as "tell".
    if let g = groups(newRe, original) ?? groups(newRe2, original) {
        let message = g[1].trimmingCharacters(in: .whitespaces)
        if !message.isEmpty { return .newChat(message: message) }
    }
    if let g = groups(tellRe, original) {
        let name = chatName(g[1]), message = g[2].trimmingCharacters(in: .whitespaces)
        if !name.isEmpty, !message.isEmpty { return .tell(chat: name, message: message) }
    }
    if let g = groups(allowRe, c) { return .allow(chat: chatName(g[1]).nilIfEmpty) }
    if let g = groups(denyRe, c) { return .deny(chat: chatName(g[1]).nilIfEmpty) }
    if let g = groups(stopRe, c) { return .stop(chat: chatName(g[1]).nilIfEmpty) }
    if let g = groups(readRe, c) {
        let name = chatName(g[1])
        if ["it", "that", "they", "this"].contains(name) { return .read(chat: nil) }
        if !name.isEmpty { return .read(chat: name) }
    }
    return inChat ? .tell(chat: nil, message: original) : .unknown(original)
}

private let namePrefix = rx(#"^(?:the|my|our|a)\s+"#)
private let nameSuffix = rx(#"\s+(?:chat|agent|session|one|task)$"#)

/// "the login chat" → "login".
private func chatName(_ s: String) -> String {
    strip(nameSuffix, strip(namePrefix, s.trimmingCharacters(in: .whitespaces))).trimmingCharacters(in: .whitespaces)
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: Which chat a spoken name means

/// A chat the driver can name.
public struct CarChatName: Equatable, Sendable {
    public var id: String
    public var title: String
    public init(id: String, title: String) { self.id = id; self.title = title }
}

public enum CarChatMatch: Equatable, Sendable {
    case one(String)
    /// Close matches, best first (at most three), to read out as a choice.
    case several([String])
    case none
}

/// Words that never tell two chats apart.
private let fillers: Set<String> = ["the", "a", "an", "chat", "agent", "session", "task", "one", "my", "our", "about", "on",
                                    "in", "for", "of", "to", "and", "with", "that", "this", "it"]

/// Lowercased, accent-free words, without punctuation; "tests" counts as "test", "retries" as "retry".
func carWords(_ s: String) -> [String] {
    let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en"))
    let parts = folded.split { !$0.isLetter && !$0.isNumber }.map(String.init)
    return parts.map { w in
        if w.count > 4, w.hasSuffix("ies") { return String(w.dropLast(3)) + "y" }
        return w.count > 3 && w.hasSuffix("s") && !w.hasSuffix("ss") ? String(w.dropLast()) : w
    }
}

/// How well `query` names `title`, 0...1: the share of the query's meaningful words
/// found in the title (a word also matches the start of a longer one, "auth" in
/// "authentication"), with a small bonus for a title that is the query exactly.
public func carNameScore(_ query: String, title: String) -> Double {
    let q = carWords(query).filter { !fillers.contains($0) }
    let t = carWords(title)
    guard !q.isEmpty, !t.isEmpty else { return 0 }
    let hit = q.filter { w in t.contains { $0 == w || (w.count >= 3 && $0.hasPrefix(w)) || ($0.count >= 3 && w.hasPrefix($0)) } }
    var score = Double(hit.count) / Double(q.count)
    if carWords(query) == t { score += 0.5 }
    else if score == 1 { score += 0.25 * Double(q.count) / Double(max(t.filter { !fillers.contains($0) }.count, q.count)) }
    return score
}

/// The chat a spoken name means: the single best match at least half named, or the
/// close ones when two are about as good, or none.
public func matchCarChat(_ query: String, among chats: [CarChatName]) -> CarChatMatch {
    let scored = chats.map { ($0.id, carNameScore(query, title: $0.title)) }.filter { $0.1 >= 0.5 }
        .sorted { $0.1 > $1.1 }
    guard let best = scored.first else { return .none }
    let close = scored.filter { best.1 - $0.1 < 0.2 }
    return close.count == 1 ? .one(best.0) : .several(close.prefix(3).map(\.0))
}
