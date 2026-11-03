import Foundation

/// The topics an agent's message can name (spec/chat/thinking-and-replies.md):
/// a line of its own, as a heading or a bold label, that says what follows. A
/// port of the desktop's `replyTopics.ts`, with the same tests.
public enum Topic: Sendable {
    case question, next, command, decision, summary
}

/// A line that names a topic, and any words after the label (`**Next step**: merge it`).
public struct TopicLine: Equatable, Sendable {
    public let topic: Topic
    public let label: String
    public let rest: String
}

/// A run of a message under one header; the first has none unless the message opens on a label.
public struct TopicSection: Equatable, Sendable {
    public let header: TopicLine?
    public let body: String
}

/// How a block of the agent's text reads: `working` is a progress note,
/// `attention` a mid-turn message left for the reader, `reply` closes a turn
/// that did work. A reply with no steps before it has nothing to stand out
/// from, so it has no voice.
public enum Voice: Sendable {
    case working, attention, reply
}

public enum ReplyTopics {
    // shortcut: English labels only, add translations once the prompt asks for them.
    nonisolated(unsafe) private static let topics: [(Topic, Regex<AnyRegexOutput>)] = [
        (.question, try! Regex(#"^(open )?questions?( for you)?$|^decisions? needed$"#)),
        (.next, try! Regex(#"^next steps?$|^what'?s next$|^action (needed|required)$|^your turn$"#)),
        (.command, try! Regex(#"^run this$|^commands?( to run)?$"#)),
        (.decision, try! Regex(#"^decisions?( made)?$|^assumptions?$"#)),
        (.summary, try! Regex(#"^summary$|^tl;?dr$|^changes$|^what changed$|^verified$|^not verified( / blocked)?$|^blocked$"#)),
    ]
    private static let fence = "```"

    private static func topic(of label: String) -> Topic? {
        let name = label.trimmingCharacters(in: .whitespaces).lowercased()
        return topics.first { name.contains($0.1) }?.0
    }

    public static func topicLine(_ line: String) -> TopicLine? {
        let text = line.trimmingCharacters(in: .whitespaces)
        if let m = text.wholeMatch(of: #/#{1,6}\s+(.+?)\s*#*/#) {
            var label = String(m.1).replacingOccurrences(of: "**", with: "")
            if label.hasSuffix(":") { label.removeLast() }
            return topic(of: label).map { TopicLine(topic: $0, label: label, rest: "") }
        }
        guard let m = text.wholeMatch(of: #/\*\*([^*]+?)(:?)\*\*(:?)\s*(.*)/#) else { return nil }
        // `**Changes** to the plan` is emphasis in a sentence, not a label.
        if !m.4.isEmpty && m.2.isEmpty && m.3.isEmpty { return nil }
        return topic(of: String(m.1)).map {
            TopicLine(topic: $0, label: m.1.trimmingCharacters(in: .whitespaces), rest: String(m.4))
        }
    }

    /// The text without its code fences, which can hold anything, by paragraph.
    private static func paragraphs(_ text: String) -> [[String]] {
        let prose = text.components(separatedBy: fence).enumerated().filter { $0.offset % 2 == 0 }.map(\.element).joined(separator: "\n\n")
        return prose.split(separator: #/\n\s*\n/#, omittingEmptySubsequences: false)
            .map { $0.split(separator: "\n", omittingEmptySubsequences: false).map(String.init).filter { !isBlank($0) } }
            .filter { !$0.isEmpty }
    }

    private static func isBlank(_ s: some StringProtocol) -> Bool { s.allSatisfy(\.isWhitespace) }

    private static func endsInQuestion(_ lines: [String]?) -> Bool {
        let last = lines?.last?.trimmingCharacters(in: .whitespaces) ?? ""
        return last.contains(#/[?？][*_`)"'”’]*$/#)
    }

    /// True when a message written mid-turn is addressed to the reader: it names a topic, or it stops on a question.
    public static func speaksToUser(_ text: String) -> Bool {
        let blocks = paragraphs(text)
        return endsInQuestion(blocks.last) || blocks.contains { $0.contains { topicLine($0) != nil } }
    }

    /// True when a message closes on a question that no label already announces.
    public static func endsOnUnlabelledQuestion(_ text: String) -> Bool {
        let blocks = paragraphs(text)
        guard endsInQuestion(blocks.last), let last = blocks.last, !last.contains(where: { topicLine($0) != nil }) else { return false }
        return !blocks.joined().contains {
            let topic = topicLine($0)?.topic
            return topic == .question || topic == .next
        }
    }

    /// The voice of text the agent wrote with more of its turn still to come.
    public static func midTurnVoice(_ text: String) -> Voice { speaksToUser(text) ? .attention : .working }

    /// A message cut at its topic lines (outside code), each section to draw
    /// under a header. With `askTail`, a closing question no label announces
    /// gets a Question header over its paragraph.
    public static func sections(_ text: String, askTail: Bool = false) -> [TopicSection] {
        let lines = text.components(separatedBy: "\n")
        let ask = askTail && endsOnUnlabelledQuestion(text) ? lastParagraph(lines) : -1
        var out: [TopicSection] = []
        var header: TopicLine?
        var body: [String] = []
        func flush() {
            let s = body.joined(separator: "\n").trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            if header != nil || !isBlank(s) { out.append(TopicSection(header: header, body: s)) }
            body = []
        }
        var inFence = false
        for (i, line) in lines.enumerated() {
            let topic = inFence ? nil : topicLine(line)
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(fence) { inFence.toggle() }
            if let topic {
                flush(); header = topic
                if !topic.rest.isEmpty { body.append(topic.rest) }
            } else if i == ask {
                flush(); header = TopicLine(topic: .question, label: "Question", rest: "")
                body.append(line)
            } else {
                body.append(line)
            }
        }
        flush()
        return out
    }

    /// Where the last paragraph of prose starts, outside code fences.
    private static func lastParagraph(_ lines: [String]) -> Int {
        var start = -1, inFence = false, gap = true
        for (i, line) in lines.enumerated() {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(fence) { inFence.toggle(); gap = true }
            else if inFence { continue }
            else if isBlank(line) { gap = true }
            else if gap { start = i; gap = false }
        }
        return start
    }

    /// Each block's voice, by its place in its turn: text with more of the turn
    /// after it is a note or a message for the reader; the turn's last text is
    /// the reply once the turn is over. `running` says the newest turn is live,
    /// so its last text has no voice yet.
    public static func voices(_ blocks: [Block], running: Bool = false) -> [Voice?] {
        var out = [Voice?](repeating: nil, count: blocks.count)
        let users = blocks.indices.filter { blocks[$0].isUser }
        let bounds = [-1] + users + [blocks.count]
        for (a, b) in zip(bounds, bounds.dropFirst()) where b - a > 1 {
            let turn = (a + 1)..<b
            let worked = turn.contains { if case .tool = blocks[$0] { return true } else { return false } }
            for i in turn {
                guard case .assistant(_, let text, _, let streaming, _) = blocks[i], !isBlank(text) else { continue }
                if i < b - 1 { out[i] = midTurnVoice(text) }
                else if !streaming && worked && !(running && b == blocks.count) { out[i] = .reply }
            }
        }
        return out
    }
}
