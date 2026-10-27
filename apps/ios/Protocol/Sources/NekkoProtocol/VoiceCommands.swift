import Foundation

/// What a spoken segment means. A twin of apps/desktop/src/renderer/voiceCommands.ts:
/// both run packages/shared/fixtures/voice-commands.json, so change them together.
/// `navigate` carries the desktop view id ("settings"), `go` a desktop or screen
/// target ("desktop:2", "desktop:-1", "screen:3"); the app decides what they do on a phone.
public enum VoiceIntent: Equatable, Sendable {
    case dictation(String), newSession, completeSession, navigate(String), go(String), erase, clear, send, status, ship
    case openChat(query: String, text: String)
    case pick(Int), yes, no, unknown(String)
}

private func rx(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) }

/// Capture groups of the first match (group 0 first, an unmatched group is ""), nil when there is none.
private func groups(_ re: NSRegularExpression, _ s: String) -> [String]? {
    guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
    return (0..<m.numberOfRanges).map { Range(m.range(at: $0), in: s).map { String(s[$0]) } ?? "" }
}

private func matches(_ re: NSRegularExpression, _ s: String) -> Bool { groups(re, s) != nil }

// Recognizers spell the wake word as they hear it: Nekko, Neko, Neco, Necko.
private let wake = rx(#"^ne[ck]k?o\b[\s,:.!?-]*"#)
private let wakeOnly = rx(#"^ne[ck]k?o\b[\s,:.!?-]*$"#)
private let newSession = rx(#"^(?:(?:create|start|open)(?: a)? new (?:session|chat|agent)|new (?:agent )?(?:session|chat|agent)|let's (?:make|start|create) a new (?:change|session|chat|task))$"#)
private let completeSession = rx(#"^(?:complete|finish|archive) (?:this|the current) (?:session|chat|agent)$"#)
private let erase = rx(#"^(?:erase|scratch|cancel|undo) that$"#)
private let clear = rx(#"^clear(?: everything| all| it)?$"#)
private let send = rx(#"^send(?: it| that)?$"#)
private let ship = rx(#"^ship(?: it| that)?$"#)
private let status = rx(#"^(?:status|how(?:'s| is) it going|what's the status)$"#)
private let yes = rx(#"^(?:yes|yeah|yep|confirm|do it)$"#)
private let no = rx(#"^(?:no|nope|cancel|never ?mind)$"#)
private let pickRe = rx(#"^(?:the )?(first|second|third|one|two|three|1|2|3)(?: one)?$"#)
private let stepRe = rx(#"^(?:go to |switch to |move to )?(?:the )?(next|previous|last) (?:desktop|space)$"#)
private let toRe = rx(#"^(?:go to|switch(?: to)?|move to|show) (?:the )?(desktop|space|screen|monitor|display) (\w+)$"#)
private let openPrefix = rx(#"^(?:go to|open|show|switch to) (?:the )?"#)
private let tabSuffix = rx(#" (?:tab|page)$"#)
private let otherOne = rx(#"^open the (?:other )?one (?:about|related to|on) (.+)$"#)
private let switchOpen = rx(#"^(?:switch to|open) (.+)$"#)
private let articlePrefix = rx(#"^(?:the|a) "#)
private let screenWords = rx(#"^(?:desktop|space|screen|monitor|display)"#)
private let trailingPunct = rx(#"[.!?]+$"#)
private let sentenceEnd = rx(#"(?<=[.!?])\s+"#)

private let views: [String: String] = ["agent board": "command", "command center": "command", "agents": "command", "models": "models", "model providers": "models", "model server": "modelserver", "settings": "settings", "connectors": "connectors", "memory": "memory", "skills": "skills", "training": "training", "workflows": "workflows", "design": "design", "artifacts": "artifacts"]
private let picks: [String: Int] = ["first": 1, "one": 1, "1": 1, "second": 2, "two": 2, "2": 2, "third": 3, "three": 3, "3": 3]
private let numberWords: [String: Int] = ["one": 1, "two": 2, "to": 2, "too": 2, "three": 3, "four": 4, "for": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9]

private func strip(_ re: NSRegularExpression, _ s: String) -> String {
    re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
}

/// Only an explicit leading address can turn dictation into an app action.
public func parseVoiceIntent(_ text: String) -> VoiceIntent {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let address = groups(wake, trimmed)?[0] else { return .dictation(trimmed) }
    let spoken = String(trimmed.dropFirst(address.count)).lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
    let command = strip(trailingPunct, spoken).trimmingCharacters(in: .whitespacesAndNewlines)

    if matches(newSession, command) { return .newSession }
    if matches(completeSession, command) { return .completeSession }
    if matches(erase, command) { return .erase }
    if matches(clear, command) { return .clear }
    if matches(send, command) { return .send }
    if matches(ship, command) { return .ship }
    if matches(status, command) { return .status }
    if matches(yes, command) { return .yes }
    if matches(no, command) { return .no }
    if let g = groups(pickRe, command), let n = picks[g[1]] { return .pick(n) }
    if let target = parseGo(command) { return .go(target) }
    let target = strip(tabSuffix, strip(openPrefix, command))
    if target != command, let view = views[target] { return .navigate(view) }
    // Views and desktop/screen words keep winning; whatever else follows "open" or "switch to" names a chat.
    let chat = groups(otherOne, command) ?? groups(switchOpen, command)
    if let chat {
        let query = strip(articlePrefix, chat[1])
        if views[strip(tabSuffix, query)] == nil, !matches(screenWords, query) { return .openChat(query: query, text: trimmed) }
    }
    return .unknown(trimmed)
}

/// "switch to desktop 2", "go to screen two", "next desktop", "previous space".
/// Recognizers hear "two" as "to".
private func parseGo(_ command: String) -> String? {
    if let g = groups(stepRe, command) { return "desktop:\(g[1] == "next" ? 1 : -1)" }
    guard let g = groups(toRe, command) else { return nil }
    let n = Int(g[2]) ?? numberWords[g[2]] ?? 0
    if n < 1 || n > 16 { return nil }
    return "\(g[1] == "desktop" || g[1] == "space" ? "desktop" : "screen"):\(n)"
}

/// Splits a transcript at sentence ends and parses each piece; adjacent dictation pieces rejoin.
public func splitVoiceSegments(_ text: String) -> [VoiceIntent] {
    var pieces: [String] = []
    var from = text.startIndex
    for m in sentenceEnd.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let r = Range(m.range, in: text) else { continue }
        pieces.append(String(text[from..<r.lowerBound])); from = r.upperBound
    }
    pieces.append(String(text[from...]))
    pieces = pieces.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var out: [VoiceIntent] = []
    var i = 0
    while i < pieces.count {
        // Recognizers punctuate a pause after the wake word ("Nekko. Send it."): it still addresses the next sentence.
        var piece = pieces[i]
        if matches(wakeOnly, piece.trimmingCharacters(in: .whitespacesAndNewlines)), i + 1 < pieces.count { piece += " " + pieces[i + 1]; i += 1 }
        i += 1
        let intent = parseVoiceIntent(piece)
        if case .dictation(let more) = intent, case .dictation(let had)? = out.last { out[out.count - 1] = .dictation(had + " " + more) }
        else { out.append(intent) }
    }
    return out
}
