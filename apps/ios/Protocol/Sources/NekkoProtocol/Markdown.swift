import Foundation

/// The Markdown a chat contains, as a small block tree: paragraphs, headings,
/// fenced code, quotes, rules, real nested lists and pipe tables. Inline
/// styling (bold, links, code spans) stays inside the strings; the app renders
/// it with `AttributedString(markdown:)`.
///
/// Mirrors the desktop renderer (`apps/desktop/src/renderer/components/Markdown.tsx`):
/// not CommonMark, but the constructs agent replies and phone messages use.
/// Dependency-free and pure, so it is tested on Linux.
public enum MarkdownBlock: Equatable, Sendable {
    /// One or more lines; single newlines are kept as line breaks, as chat writes them.
    case paragraph(String)
    case heading(level: Int, text: String)
    /// `closed` is false while a streaming reply has not written the closing fence yet.
    case code(language: String, body: String, closed: Bool)
    case quote([MarkdownBlock])
    case list(MarkdownList)
    case table(MarkdownTable)
    case rule
}

public struct MarkdownList: Equatable, Sendable {
    public var ordered: Bool
    /// The first item's number (an ordered list may start anywhere).
    public var start: Int
    public var items: [MarkdownListItem]

    public init(ordered: Bool, start: Int = 1, items: [MarkdownListItem]) {
        self.ordered = ordered
        self.start = start
        self.items = items
    }
}

public struct MarkdownListItem: Equatable, Sendable {
    public enum Task: Equatable, Sendable { case open, done }
    /// The item's text; wrapped and continuation lines are joined with `\n`
    /// (`\n\n` after a blank line), so they hang under the item, not the marker.
    public var text: String
    public var task: Task?
    /// Lists nested under this item, in order (a bullet list under a numbered item, say).
    public var children: [MarkdownList]

    public init(_ text: String, task: Task? = nil, children: [MarkdownList] = []) {
        self.text = text
        self.task = task
        self.children = children
    }
}

public struct MarkdownTable: Equatable, Sendable {
    public enum Alignment: String, Equatable, Sendable { case leading, center, trailing }
    public var header: [String]
    public var alignments: [Alignment]
    /// Body rows, each padded (or cut) to the header's column count.
    public var rows: [[String]]

    public init(header: [String], alignments: [Alignment], rows: [[String]]) {
        self.header = header
        self.alignments = alignments
        self.rows = rows
    }

    /// What VoiceOver reads for one cell: "Row 2, Name: Nekko". `row` 0 is the header.
    public func accessibilityLabel(row: Int, column: Int) -> String {
        let name = header.indices.contains(column) ? header[column] : ""
        guard row > 0 else { return "Column header: \(name)" }
        let value = rows.indices.contains(row - 1) && rows[row - 1].indices.contains(column) ? rows[row - 1][column] : ""
        let shown = value.isEmpty ? "empty" : value
        return name.isEmpty ? "Row \(row): \(shown)" : "Row \(row), \(name): \(shown)"
    }

    /// More than this many columns or body rows gets an Expand button on the phone.
    public static let expandColumns = 4
    public static let expandRows = 12
    public var isLarge: Bool { header.count > Self.expandColumns || rows.count > Self.expandRows }

    /// The table as tidy Markdown (Copy as Markdown); pipes in cells are escaped.
    public var markdown: String {
        func row(_ cells: [String]) -> String {
            "| " + cells.map { $0.replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |"
        }
        let divider = "| " + alignments.map { a -> String in
            switch a {
            case .leading: return "---"
            case .center: return ":---:"
            case .trailing: return "---:"
            }
        }.joined(separator: " | ") + " |"
        return ([row(header), divider] + rows.map(row)).joined(separator: "\n")
    }

    /// Tab-separated plain text (Copy as text): pastes into Numbers and Sheets as cells.
    public var tabSeparated: String {
        func clean(_ s: String) -> String {
            MarkdownParser.plainText(s).replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
        }
        return ([header] + rows).map { $0.map(clean).joined(separator: "\t") }.joined(separator: "\n")
    }

    /// What VoiceOver reads for body row `index` (0-based): "Row 2 of 5: Name, Nekko; Status, done".
    public func accessibilityRow(_ index: Int) -> String {
        guard rows.indices.contains(index) else { return "" }
        let pairs = zip(header, rows[index]).map { "\(MarkdownParser.plainText($0)), \(MarkdownParser.plainText($1))" }
        return "Row \(index + 1) of \(rows.count): " + pairs.joined(separator: "; ")
    }
}

public enum MarkdownParser {
    // MARK: Whole text, cached by segment

    /// The blocks of `text`. Finished segments (see `segments`) are parsed once
    /// and cached, so a streaming reply re-parses only the segment being written.
    /// Always equal to `parse(text)`.
    public static func blocks(_ text: String) -> [MarkdownBlock] {
        segments(text).flatMap(cachedParse)
    }

    /// `text` split where no block carries across: at a blank line (outside a
    /// fence) followed by an unindented line. An indented line after a blank one
    /// can still belong to the list above (a nested item, an item's second
    /// paragraph), so it stays in the same segment.
    public static func segments(_ text: String) -> [String] {
        var out: [String] = []
        var current: [Substring] = []
        var blanks: [Substring] = []
        var fence: MDFence?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let l = MDLine(line)
            if fence == nil && l.isBlank {
                blanks.append(line)
                continue
            }
            if !blanks.isEmpty {
                if fence == nil && l.indent == 0 && !current.isEmpty {
                    out.append(current.joined(separator: "\n"))
                    current = []
                } else {
                    current += blanks
                }
                blanks = []
            }
            current.append(line)
            if let f = fence {
                if f.closes(l) { fence = nil }
            } else {
                fence = MDFence(l)
            }
        }
        if !current.isEmpty { out.append(current.joined(separator: "\n")) }
        return out
    }

    private final class Box {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 2_000
        return c
    }()

    private static func cachedParse(_ segment: String) -> [MarkdownBlock] {
        let key = segment as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parse(segment)
        cache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    // MARK: Parsing

    /// Parse `text` in one pass, uncached.
    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(MDLine.init)
        var i = 0
        return parseBlocks(lines, &i)
    }

    private static func parseBlocks(_ lines: [MDLine], _ i: inout Int) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        while i < lines.count {
            let l = lines[i]
            if l.isBlank { i += 1; continue }
            if let f = MDFence(l) {
                var body: [String] = []
                var closed = false
                i += 1
                while i < lines.count {
                    if f.closes(lines[i]) { closed = true; i += 1; break }
                    body.append(f.strip(lines[i]))
                    i += 1
                }
                out.append(.code(language: f.info, body: body.joined(separator: "\n"), closed: closed))
                continue
            }
            if let h = heading(l) { out.append(h); i += 1; continue }
            if isRule(l) { out.append(.rule); i += 1; continue }
            if l.content.hasPrefix(">") {
                var inner: [MDLine] = []
                while i < lines.count, lines[i].content.hasPrefix(">") {
                    var rest = lines[i].content.dropFirst()
                    if rest.first == " " { rest = rest.dropFirst() }
                    inner.append(MDLine(rest))
                    i += 1
                }
                var j = 0
                out.append(.quote(parseBlocks(inner, &j)))
                continue
            }
            if let table = table(lines, &i) { out.append(.table(table)); continue }
            if listItem(l) != nil { out += list(lines, &i).map(MarkdownBlock.list); continue }
            var para: [String] = []
            while i < lines.count, !lines[i].isBlank, para.isEmpty || !startsBlock(lines, i, interrupting: true) {
                para.append(String(lines[i].raw))
                i += 1
            }
            out.append(.paragraph(para.joined(separator: "\n")))
        }
        return out
    }

    /// True for a line that starts a block of its own, so a paragraph or list item stops.
    /// Inside a paragraph only a numbered item starting at 1 begins a list, as in
    /// CommonMark, so a sentence that wraps onto "2026. A year." stays a sentence.
    private static func startsBlock(_ lines: [MDLine], _ i: Int, interrupting: Bool = false) -> Bool {
        let l = lines[i]
        if let item = listItem(l) { return !interrupting || !item.ordered || item.number == 1 }
        return l.isBlank || MDFence(l) != nil || heading(l) != nil || isRule(l) || l.content.hasPrefix(">") || isTableStart(lines, i)
    }

    private static func heading(_ l: MDLine) -> MarkdownBlock? {
        let c = l.content
        let hashes = c.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = c.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // A closing run of #s is decoration (`## Title ##`).
        if let r = text.range(of: #"\s+#+$"#, options: .regularExpression) { text.removeSubrange(r) } else if text.allSatisfy({ $0 == "#" }) { text = "" }
        return .heading(level: hashes, text: text)
    }

    private static func isRule(_ l: MDLine) -> Bool {
        let s = l.content.filter { $0 != " " && $0 != "\t" }
        guard s.count >= 3, let c = s.first, "-*_".contains(c) else { return false }
        return s.allSatisfy { $0 == c }
    }

    // MARK: Lists

    struct Item {
        var indent: Int
        var ordered: Bool
        var number: Int
        var text: String
    }

    /// A list item's marker and text: `- x`, `* x`, `+ x`, `1. x`, `1) x`. An empty item (`- `) counts.
    static func listItem(_ l: MDLine) -> Item? {
        let c = l.content
        guard let first = c.first else { return nil }
        if "-*+".contains(first) {
            let rest = c.dropFirst()
            if rest.isEmpty { return nil }
            guard rest.first == " " || rest.first == "\t" else { return nil }
            return Item(indent: l.indent, ordered: false, number: 0, text: String(rest.drop { $0 == " " || $0 == "\t" }))
        }
        let digits = c.prefix(while: { ("0"..."9").contains($0) })
        guard (1...9).contains(digits.count) else { return nil }
        let rest = c.dropFirst(digits.count)
        guard let d = rest.first, d == "." || d == ")" else { return nil }
        let after = rest.dropFirst()
        guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
        // "1." alone is an empty item only with a space after it; a bare "2026." is a sentence.
        if after.isEmpty { return nil }
        return Item(indent: l.indent, ordered: true, number: Int(digits) ?? 1, text: String(after.drop { $0 == " " || $0 == "\t" }))
    }

    private static func list(_ lines: [MDLine], _ i: inout Int) -> [MarkdownList] {
        var flat: [Item] = []
        var afterBlank = false
        while i < lines.count {
            let l = lines[i]
            if l.isBlank {
                // A blank line ends the list unless an indented line follows (a nested item, a second paragraph).
                var k = i
                while k < lines.count, lines[k].isBlank { k += 1 }
                guard k < lines.count, lines[k].indent > 0, MDFence(lines[k]) == nil else { break }
                afterBlank = true
                i = k
                continue
            }
            if let item = listItem(l) {
                if isRule(l) { break }
                flat.append(item)
            } else if startsBlock(lines, i) {
                break
            } else if let owner = flat.lastIndex(where: { $0.indent < l.indent }) ?? flat.indices.last {
                // A wrapped or continued line hangs under the item that owns it: the
                // nearest one above it that is less indented, or (lazily) the last one.
                flat[owner].text += (afterBlank ? "\n\n" : "\n") + l.content
            }
            afterBlank = false
            i += 1
        }
        return nest(flat[...])
    }

    /// Fold a flat run of items into lists: items more indented than the run's
    /// first become children of the item above them. A change between bullets
    /// and numbers at the same level starts a new list.
    private static func nest(_ flat: ArraySlice<Item>) -> [MarkdownList] {
        guard let base = flat.first?.indent else { return [] }
        var lists: [MarkdownList] = []
        var i = flat.startIndex
        while i < flat.endIndex {
            var end = i + 1
            while end < flat.endIndex, flat[end].indent > base { end += 1 }
            let it = flat[i]
            var text = it.text
            var task: MarkdownListItem.Task?
            if text.hasPrefix("[ ]") || text.hasPrefix("[x]") || text.hasPrefix("[X]") {
                let after = text.dropFirst(3)
                if after.isEmpty || after.first == " " || after.first == "\n" {
                    task = text.hasPrefix("[ ]") ? .open : .done
                    text = String(after.drop { $0 == " " })
                }
            }
            let item = MarkdownListItem(text, task: task, children: nest(flat[(i + 1)..<end]))
            if var last = lists.last, last.ordered == it.ordered {
                last.items.append(item)
                lists[lists.count - 1] = last
            } else {
                lists.append(MarkdownList(ordered: it.ordered, start: it.ordered ? it.number : 1, items: [item]))
            }
            i = end
        }
        return lists
    }

    /// The marker drawn for an item: •, ◦, ▪ for bullets and 1., a., i. for
    /// numbers, by nesting depth (0 at the top), cycling after three levels.
    public static func marker(ordered: Bool, depth: Int, number: Int) -> String {
        let level = depth % 3
        guard ordered else { return ["•", "◦", "▪"][level] }
        switch level {
        case 0: return "\(number)."
        case 1: return letters(number) + "."
        default: return roman(number) + "."
        }
    }

    static func letters(_ n: Int) -> String {
        guard n > 0 else { return "\(n)" }
        var n = n
        var s = ""
        while n > 0 {
            n -= 1
            s = String(UnicodeScalar(UInt8(97 + n % 26))) + s
            n /= 26
        }
        return s
    }

    static func roman(_ n: Int) -> String {
        guard n > 0, n < 4000 else { return "\(n)" }
        let table: [(Int, String)] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"),
                                      (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
        var n = n
        var s = ""
        for (v, r) in table { while n >= v { s += r; n -= v } }
        return s
    }

    // MARK: Tables

    /// A header row with a pipe, then a `|---|:---:|` divider.
    static func isTableStart(_ lines: [MDLine], _ i: Int) -> Bool {
        guard i + 1 < lines.count, lines[i].content.contains("|"), listItem(lines[i]) == nil else { return false }
        return isDivider(lines[i + 1], columns: cells(String(lines[i].content)).count)
    }

    /// `|---|:---:|`, with as many cells as the header (so a rule under a sentence with a pipe stays a rule).
    private static func isDivider(_ l: MDLine, columns: Int) -> Bool {
        let c = l.content.trimmingCharacters(in: .whitespaces)
        guard c.contains("-"), c.contains("|"), c.allSatisfy({ "|:- \t".contains($0) }) else { return false }
        let d = cells(c)
        guard d.count == columns else { return false }
        // Every cell of the divider is dashes with optional colons.
        return d.allSatisfy { cell in
            let t = cell.trimmingCharacters(in: .whitespaces)
            return !t.isEmpty && t.contains("-") && t.dropFirst().dropLast().allSatisfy { $0 == "-" }
        }
    }

    private static func table(_ lines: [MDLine], _ i: inout Int) -> MarkdownTable? {
        guard isTableStart(lines, i) else { return nil }
        let header = cells(String(lines[i].content))
        let alignments: [MarkdownTable.Alignment] = header.indices.map { k in
            let d = cells(String(lines[i + 1].content))
            guard k < d.count else { return .leading }
            let t = d[k].trimmingCharacters(in: .whitespaces)
            if t.hasPrefix(":") && t.hasSuffix(":") && t.count > 1 { return .center }
            if t.hasSuffix(":") { return .trailing }
            return .leading
        }
        i += 2
        var rows: [[String]] = []
        while i < lines.count, !lines[i].isBlank, lines[i].content.contains("|"), MDFence(lines[i]) == nil {
            var r = cells(String(lines[i].content))
            if r.count < header.count { r += Array(repeating: "", count: header.count - r.count) }
            rows.append(Array(r.prefix(header.count)))
            i += 1
        }
        return MarkdownTable(header: header, alignments: alignments, rows: rows)
    }

    /// A row's cells: outer pipes dropped, split on unescaped pipes, `\|` kept as a literal pipe.
    public static func cells(_ row: String) -> [String] {
        var s = Substring(row.trimmingCharacters(in: .whitespaces))
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s = s.dropLast() }
        var out: [String] = []
        var cell = ""
        var escaped = false
        for ch in s {
            if escaped {
                cell += ch == "|" ? "|" : "\\" + String(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                out.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(ch)
            }
        }
        if escaped { cell += "\\" }
        out.append(cell.trimmingCharacters(in: .whitespaces))
        return out
    }

    // MARK: Plain text

    /// Inline Markdown reduced to what it says: `[t](u)` → t, and `**`, `__`, `~~` and backticks dropped.
    public static func plainText(_ s: String) -> String {
        var out = s
        if let re = try? NSRegularExpression(pattern: #"!?\[([^\]]*)\]\([^)]*\)"#) {
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "$1")
        }
        for mark in ["**", "__", "~~", "`"] { out = out.replacingOccurrences(of: mark, with: "") }
        return out
    }
}

// MARK: - Lines and fences

/// One source line, with its indentation measured (a tab counts as four spaces).
struct MDLine {
    let raw: Substring
    let indent: Int
    let content: Substring

    init(_ raw: Substring) {
        self.raw = raw
        var n = 0
        var idx = raw.startIndex
        while idx < raw.endIndex, raw[idx] == " " || raw[idx] == "\t" {
            n += raw[idx] == "\t" ? 4 : 1
            idx = raw.index(after: idx)
        }
        indent = n
        var c = raw[idx...]
        while let last = c.last, last == " " || last == "\t" || last == "\r" { c = c.dropLast() }
        content = c
    }

    var isBlank: Bool { content.isEmpty }
}

/// An opening ``` or ~~~ fence: its character, length, info string and indentation.
struct MDFence {
    let char: Character
    let length: Int
    let info: String
    let indent: Int

    init?(_ l: MDLine) {
        guard let c = l.content.first, c == "`" || c == "~" else { return nil }
        let run = l.content.prefix { $0 == c }.count
        guard run >= 3 else { return nil }
        let info = l.content.dropFirst(run).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string can't hold a backtick (that's inline code).
        if c == "`" && info.contains("`") { return nil }
        char = c
        length = run
        self.info = info.split(separator: " ").first.map(String.init) ?? ""
        indent = l.indent
    }

    func closes(_ l: MDLine) -> Bool {
        let run = l.content.prefix { $0 == char }.count
        return run >= length && run == l.content.count
    }

    /// A body line with the fence's own indentation taken off (code inside a list item).
    func strip(_ l: MDLine) -> String {
        var s = l.raw
        var n = 0
        while n < indent, let f = s.first, f == " " { s = s.dropFirst(); n += 1 }
        return String(s)
    }
}
