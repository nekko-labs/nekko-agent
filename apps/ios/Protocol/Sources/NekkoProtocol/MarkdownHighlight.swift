import Foundation

/// The composer's light live styling of Markdown source (MD-3): the text stays
/// as typed, and these spans say how to draw it. Bold looks bold with its `**`
/// dimmed, headings are larger, list markers are tinted, code is monospaced.
/// Ranges are UTF-16, as `NSAttributedString` counts them.
public struct MarkdownSpan: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case heading(Int)
        /// Syntax drawn quieter: `**`, `#`, `` ` ``, a link's `](url)`.
        case syntax
        /// A list or quote marker, tinted.
        case marker
        case bold, italic, strike, code, link
        /// A fenced block's lines, fences included.
        case fence
    }

    public var kind: Kind
    public var range: NSRange

    public init(_ kind: Kind, _ range: NSRange) {
        self.kind = kind
        self.range = range
    }
}

public enum MarkdownHighlight {
    /// Drafts longer than this are drawn plain (styling runs on every keystroke).
    public static let maxLength = 20_000

    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.anchorsMatchLines]) }
    private static let heading = re(#"^ {0,3}(#{1,6}) .*$"#)
    private static let listMarker = re(#"^[ \t]*([-+*] \[[ xX]\]|[-+*]|\d{1,9}[.)])(?= )"#)
    private static let quoteMarker = re(#"^[ \t]*(>)"#)
    private static let fence = re(#"^[ \t]*(```|~~~)"#)
    private static let codeSpan = re(#"`[^`\n]+`"#)
    private static let bold = re(#"\*\*[^*\n]+?\*\*|__[^_\n]+?__"#)
    private static let italic = re(#"(?<![*\w])\*(?!\*)[^*\n]+?(?<!\*)\*(?!\*)|(?<![_\w])_(?!_)[^_\n]+?(?<!_)_(?![_\w])"#)
    private static let strike = re(#"~~[^~\n]+?~~"#)
    private static let link = re(#"\[([^\]\n]+)\](\([^)\n]*\))"#)

    public static func spans(_ text: String) -> [MarkdownSpan] {
        let s = text as NSString
        guard s.length <= maxLength else { return [] }
        var out: [MarkdownSpan] = []
        let all = NSRange(location: 0, length: s.length)

        // Fenced blocks first: nothing inside them is Markdown.
        var fenced: [NSRange] = []
        var open: Int?
        for m in fence.matches(in: text, range: all) {
            let line = s.lineRange(for: m.range)
            if let start = open {
                fenced.append(NSRange(location: start, length: NSMaxRange(line) - start))
                open = nil
            } else {
                open = line.location
            }
        }
        if let start = open { fenced.append(NSRange(location: start, length: s.length - start)) }
        out += fenced.map { MarkdownSpan(.fence, $0) }
        func free(_ r: NSRange) -> Bool { !fenced.contains { NSIntersectionRange($0, r).length > 0 } }

        for m in heading.matches(in: text, range: all) where free(m.range) {
            out.append(MarkdownSpan(.heading(m.range(at: 1).length), m.range))
            out.append(MarkdownSpan(.syntax, m.range(at: 1)))
        }
        for m in listMarker.matches(in: text, range: all) where free(m.range) { out.append(MarkdownSpan(.marker, m.range(at: 1))) }
        for m in quoteMarker.matches(in: text, range: all) where free(m.range) { out.append(MarkdownSpan(.marker, m.range(at: 1))) }

        var code: [NSRange] = []
        for m in codeSpan.matches(in: text, range: all) where free(m.range) {
            code.append(m.range)
            out.append(MarkdownSpan(.code, m.range))
            out.append(MarkdownSpan(.syntax, NSRange(location: m.range.location, length: 1)))
            out.append(MarkdownSpan(.syntax, NSRange(location: NSMaxRange(m.range) - 1, length: 1)))
        }
        func plain(_ r: NSRange) -> Bool { free(r) && !code.contains { NSIntersectionRange($0, r).length > 0 } }

        func marked(_ regex: NSRegularExpression, _ kind: MarkdownSpan.Kind, mark: Int) {
            for m in regex.matches(in: text, range: all) where plain(m.range) {
                out.append(MarkdownSpan(kind, m.range))
                out.append(MarkdownSpan(.syntax, NSRange(location: m.range.location, length: mark)))
                out.append(MarkdownSpan(.syntax, NSRange(location: NSMaxRange(m.range) - mark, length: mark)))
            }
        }
        marked(bold, .bold, mark: 2)
        marked(italic, .italic, mark: 1)
        marked(strike, .strike, mark: 2)
        for m in link.matches(in: text, range: all) where plain(m.range) {
            out.append(MarkdownSpan(.link, m.range(at: 1)))
            out.append(MarkdownSpan(.syntax, NSRange(location: m.range.location, length: 1)))
            out.append(MarkdownSpan(.syntax, NSRange(location: NSMaxRange(m.range(at: 1)), length: 1 + m.range(at: 2).length)))
        }
        return out
    }
}
