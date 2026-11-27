import Foundation

// The chat list's search inside messages (#3448): what each chat said, as the
// computer sends it to phones (`sessions:finderText`, PHONE_FINDER_VIEW in
// packages/shared/src/phone-access.ts), and the desktop chat finder's match
// and snippet (apps/desktop/src/renderer/views/chatFinder.ts). Mirrors
// Android's `FinderText.kt`.

/// One message a chat's search reads: its text and the files its tool calls named.
public struct FinderMessage: Equatable, Sendable {
    public let role: String
    public let text: String
    public let files: [String]

    public init(role: String, text: String, files: [String] = []) {
        self.role = role
        self.text = text
        self.files = files
    }
}

/// What one chat said.
public struct FinderChat: Equatable, Sendable {
    public let messages: [FinderMessage]

    public init(messages: [FinderMessage]) { self.messages = messages }

    /// A `sessions:finderText` reply. A chat the computer doesn't have maps to an empty
    /// chat; one it left out (the reply was full) is absent, so it is asked for again.
    public static func parse(_ v: JSONValue?) -> [String: FinderChat] {
        guard let o = v?.object else { return [:] }
        return o.mapValues { c in
            FinderChat(messages: (c["messages"]?.array ?? []).compactMap { m in
                guard let role = m["role"]?.string else { return nil }
                return FinderMessage(role: role, text: m["text"]?.string ?? "", files: (m["files"]?.array ?? []).compactMap(\.string))
            })
        }
    }
}

/// A chat the search found, and the line that matched when its title alone did not.
public struct ChatHit: Equatable, Sendable {
    public let chat: SessionSummary
    public let snippet: String?

    public init(chat: SessionSummary, snippet: String? = nil) {
        self.chat = chat
        self.snippet = snippet
    }
}

/// The chat list's search across what chats said (`ChatSearch.matches` reads summaries only).
public enum FinderSearch {
    /// Chats one `sessions:finderText` call asks for (`PHONE_FINDER_VIEW.chats`).
    public static let batch = 20

    static let snippetBefore = 24
    static let snippetChars = 90

    /// Chats holding every word of `query`, any case or accent, in order. A word can be in the
    /// title, first prompt or last reply (`ChatSearch.matches`) or, for a chat in `texts`, in a
    /// message or a file it named. A title match needs no snippet; otherwise the snippet is the
    /// piece of the summary or of the message where a word the title lacks was found.
    public static func hits(_ chats: [SessionSummary], _ query: String, texts: [String: FinderChat]) -> [ChatHit] {
        let words = ChatSearch.fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return chats.map { ChatHit(chat: $0) } }
        return chats.compactMap { hit($0, words, texts[$0.id]) }
    }

    private static func hit(_ s: SessionSummary, _ words: [String], _ text: FinderChat?) -> ChatHit? {
        let title = ChatSearch.fold(s.title)
        if words.allSatisfy({ title.contains($0) }) { return ChatHit(chat: s) }
        let description = [s.firstUserText ?? "", s.lastReplyText ?? ""].joined(separator: "\n")
        let head = title + "\n" + ChatSearch.fold(description)
        let missing = words.filter { !head.contains($0) }
        if missing.isEmpty {
            let word = words.first { !title.contains($0) } ?? words[0]
            return ChatHit(chat: s, snippet: snippetAround(description, word))
        }
        let messages = (text?.messages ?? []).map { m in (m, ChatSearch.fold(m.text + "\n" + m.files.joined(separator: "\n"))) }
        guard missing.allSatisfy({ w in messages.contains { $0.1.contains(w) } }) else { return nil }
        // The message holding most of what the summary lacks, the newest of equals.
        var best = messages[0]
        var bestCount = -1
        for m in messages {
            let n = missing.filter { m.1.contains($0) }.count
            if n >= bestCount { best = m; bestCount = n }
        }
        guard let word = missing.first(where: { best.1.contains($0) }) else { return ChatHit(chat: s) }
        let shown = ChatSearch.fold(best.0.text).contains(word) ? best.0.text : (best.0.files.first { ChatSearch.fold($0).contains(word) } ?? best.0.text)
        return ChatHit(chat: s, snippet: snippetAround(shown, word))
    }

    /// A short piece of `text` around the first place `word` (folded) appears, as the desktop finder cuts it.
    public static func snippetAround(_ text: String, _ word: String) -> String? {
        let chars = Array(text)
        var folded: [Character] = []
        var from: [Int] = []
        for (i, ch) in chars.enumerated() {
            for f in ChatSearch.fold(String(ch)) {
                folded.append(f)
                from.append(i)
            }
        }
        let needle = Array(word)
        guard !needle.isEmpty, needle.count <= folded.count,
              let at = (0...(folded.count - needle.count)).first(where: { Array(folded[$0..<$0 + needle.count]) == needle })
        else { return nil }
        let start = max(0, from[at] - snippetBefore)
        let end = min(chars.count, start + snippetChars)
        let piece = String(chars[start..<end]).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return (start > 0 ? "…" : "") + piece + (end < chars.count ? "…" : "")
    }
}
