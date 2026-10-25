import Foundation

/// The phone composer's formatting toolbar and typing rules (MD-3), as pure
/// functions over the draft's Markdown source and its selection, so they are
/// tested on Linux. Offsets are UTF-16, as `UITextView` counts them.
///
/// Mirrors the desktop's `composerFormatting.ts` (toggle inline marks and
/// block prefixes, pressed when the selection already has the style), plus the
/// phone's list continuation, indent and outdent, and table editing.
public enum MarkdownAction: String, CaseIterable, Sendable {
    case bold, italic, strike, code, link, heading, bullet, ordered, task, indent, outdent, quote, fence, table

    /// The toolbar's VoiceOver label.
    public var label: String {
        switch self {
        case .bold: return "Bold"
        case .italic: return "Italic"
        case .strike: return "Strikethrough"
        case .code: return "Inline code"
        case .link: return "Link"
        case .heading: return "Heading"
        case .bullet: return "Bulleted list"
        case .ordered: return "Numbered list"
        case .task: return "Task list"
        case .indent: return "Indent"
        case .outdent: return "Outdent"
        case .quote: return "Quote"
        case .fence: return "Code block"
        case .table: return "Table"
        }
    }

    /// Indent, outdent and table insert act; the rest toggle and can show as pressed.
    public var toggles: Bool { ![.indent, .outdent, .table].contains(self) }
}

/// A draft after an edit: the new text and where the selection goes.
public struct MarkdownEdit: Equatable, Sendable {
    public var text: String
    public var location: Int
    public var length: Int

    public init(text: String, location: Int, length: Int = 0) {
        self.text = text
        self.location = location
        self.length = length
    }

    public var range: NSRange { NSRange(location: location, length: length) }
}

public enum MarkdownEditing {
    // MARK: Toolbar

    /// Whether the selection already has `action`'s style (the button shows pressed).
    public static func isActive(_ action: MarkdownAction, in text: String, selection: NSRange) -> Bool {
        let s = text as NSString
        let start = selection.location, end = selection.location + selection.length
        if let mark = mark(action) { return inlineSpan(s, start, end, mark) != nil }
        switch action {
        case .fence:
            return s.substring(to: start).hasSuffix("```\n") && s.substring(from: end).hasPrefix("\n```")
        case .link:
            return start > 0 && s.substring(with: NSRange(location: start - 1, length: 1)) == "[" && linkTail(s, end) != nil
        case .indent, .outdent, .table:
            return false
        default:
            let (from, to) = block(s, start, end)
            let lines = s.substring(with: NSRange(location: from, length: to - from)).components(separatedBy: "\n")
            return lines.allSatisfy { matchesPrefix(action, String($0.drop { $0 == " " || $0 == "\t" })) }
        }
    }

    /// Apply a toolbar button to the selection (or the current line, for block styles).
    public static func apply(_ action: MarkdownAction, to text: String, selection: NSRange) -> MarkdownEdit {
        switch action {
        case .indent: return indent(text, selection: selection, outdent: false)
        case .outdent: return indent(text, selection: selection, outdent: true)
        case .table: return insertTable(text, selection: selection)
        default: break
        }
        let s = text as NSString
        let start = selection.location, end = selection.location + selection.length
        let active = isActive(action, in: text, selection: selection)
        if let mark = mark(action) {
            let m = (mark as NSString).length
            if active, let span = inlineSpan(s, start, end, mark), start == end, start == span.to, span.to > span.from {
                // The caret at the end of styled text: step out past the closing marks, so typing goes on plain.
                return MarkdownEdit(text: text, location: span.to + m)
            }
            if active, let span = inlineSpan(s, start, end, mark) {
                let out = s.replacingCharacters(in: NSRange(location: span.to, length: m), with: "") as NSString
                return MarkdownEdit(text: out.replacingCharacters(in: NSRange(location: span.from - m, length: m), with: ""),
                                    location: start - m, length: end - start)
            }
            let out = s.replacingCharacters(in: NSRange(location: start, length: end - start), with: mark + s.substring(with: NSRange(location: start, length: end - start)) + mark)
            return MarkdownEdit(text: out, location: start + m, length: end - start)
        }
        if action == .link {
            if active, let tail = linkTail(s, end) {
                let out = (s.replacingCharacters(in: NSRange(location: end, length: tail), with: "") as NSString)
                    .replacingCharacters(in: NSRange(location: start - 1, length: 1), with: "")
                return MarkdownEdit(text: out, location: start - 1, length: end - start)
            }
            // `[text](url)`: with nothing selected the text is picked to type over, else the url.
            let label = s.substring(with: NSRange(location: start, length: end - start))
            let shown = label.isEmpty ? "text" : label
            let out = s.replacingCharacters(in: NSRange(location: start, length: end - start), with: "[\(shown)](url)")
            let shownLength = (shown as NSString).length
            return label.isEmpty
                ? MarkdownEdit(text: out, location: start + 1, length: shownLength)
                : MarkdownEdit(text: out, location: start + shownLength + 3, length: 3)
        }
        if action == .fence {
            if active {
                let out = (s.replacingCharacters(in: NSRange(location: end, length: 4), with: "") as NSString)
                    .replacingCharacters(in: NSRange(location: start - 4, length: 4), with: "")
                return MarkdownEdit(text: out, location: start - 4, length: end - start)
            }
            // The fence goes on lines of its own.
            let before = start > 0 && s.substring(with: NSRange(location: start - 1, length: 1)) != "\n" ? "\n" : ""
            let after = end < s.length && s.substring(with: NSRange(location: end, length: 1)) != "\n" ? "\n" : ""
            let left = before + "```\n", right = "\n```" + after
            let out = s.replacingCharacters(in: NSRange(location: start, length: end - start),
                                            with: left + s.substring(with: NSRange(location: start, length: end - start)) + right)
            return MarkdownEdit(text: out, location: start + (left as NSString).length, length: end - start)
        }
        // Block prefixes, line by line: strip any list/heading/quote prefix, then add this one (unless it was on).
        let (from, to) = block(s, start, end)
        let lines = s.substring(with: NSRange(location: from, length: to - from)).components(separatedBy: "\n")
        let updated = lines.enumerated().map { i, line -> String in
            let indent = String(line.prefix { $0 == " " || $0 == "\t" })
            let body = stripPrefix(String(line.dropFirst(indent.count)))
            let prefix: String
            if active { prefix = "" } else {
                switch action {
                case .heading: prefix = "## "
                case .bullet: prefix = "- "
                case .ordered: prefix = "\(i + 1). "
                case .task: prefix = "- [ ] "
                default: prefix = "> "
                }
            }
            return indent + prefix + body
        }
        let replacement = updated.joined(separator: "\n")
        let out = s.replacingCharacters(in: NSRange(location: from, length: to - from), with: replacement)
        let firstDelta = (updated[0] as NSString).length - (lines[0] as NSString).length
        let totalDelta = (replacement as NSString).length - (to - from)
        let newStart = max(from, start + firstDelta)
        let newEnd = max(newStart, end + totalDelta)
        return renumbered(MarkdownEdit(text: out, location: newStart, length: newEnd - newStart))
    }

    // MARK: Typing

    /// Return on a list or quote line: continue it (next number, an empty task
    /// box), or end the list when the item is empty. Nil: an ordinary newline.
    public static func newline(in text: String, selection: NSRange) -> MarkdownEdit? {
        let s = text as NSString
        let lineRange = s.lineRange(for: NSRange(location: selection.location, length: 0))
        var line = s.substring(with: lineRange)
        if line.hasSuffix("\n") { line.removeLast() }
        guard let p = linePrefix(line) else { return nil }
        let prefixEnd = lineRange.location + (p.full as NSString).length
        // The caret before the marker: an ordinary newline.
        guard selection.location >= prefixEnd else { return nil }
        let lineEnd = lineRange.location + (line as NSString).length
        let rest = s.substring(with: NSRange(location: prefixEnd, length: lineEnd - prefixEnd))
        if rest.trimmingCharacters(in: .whitespaces).isEmpty && selection.length == 0 {
            // An empty item ends the list: the marker goes, the line stays.
            let out = s.replacingCharacters(in: NSRange(location: lineRange.location, length: lineEnd - lineRange.location), with: "")
            return renumbered(MarkdownEdit(text: out, location: lineRange.location))
        }
        let next = p.indent + p.next
        let insert = "\n" + next
        let out = s.replacingCharacters(in: selection, with: insert)
        return renumbered(MarkdownEdit(text: out, location: selection.location + (insert as NSString).length))
    }

    /// Indent (or outdent) the selected lines by one list level: two spaces,
    /// or three under a numbered item. The numbers follow.
    public static func indent(_ text: String, selection: NSRange, outdent: Bool) -> MarkdownEdit {
        let s = text as NSString
        let start = selection.location, end = selection.location + selection.length
        let (from, to) = block(s, start, end)
        let lines = s.substring(with: NSRange(location: from, length: to - from)).components(separatedBy: "\n")
        var firstDelta = 0
        let updated = lines.enumerated().map { i, line -> String in
            let width = linePrefix(line)?.ordered == true ? 3 : 2
            var out = line
            if outdent {
                let spaces = line.prefix { $0 == " " }.count
                if spaces > 0 { out = String(line.dropFirst(min(spaces, width))) } else if line.hasPrefix("\t") { out = String(line.dropFirst()) }
            } else {
                out = String(repeating: " ", count: width) + line
            }
            if i == 0 { firstDelta = (out as NSString).length - (line as NSString).length }
            return out
        }
        let replacement = updated.joined(separator: "\n")
        let out = s.replacingCharacters(in: NSRange(location: from, length: to - from), with: replacement)
        let totalDelta = (replacement as NSString).length - (to - from)
        let newStart = max(from, start + firstDelta)
        return renumbered(MarkdownEdit(text: out, location: newStart, length: max(0, end + totalDelta - newStart)))
    }

    /// Numbered items counted again from the top of each list (a nested list
    /// from 1), keeping the caret where it was in the text.
    public static func renumbered(_ edit: MarkdownEdit) -> MarkdownEdit {
        let lines = edit.text.components(separatedBy: "\n")
        var out: [String] = []
        // Per indentation: the next number of the numbered list open there.
        var open: [(indent: Int, next: Int)] = []
        var location = edit.location, end = edit.location + edit.length
        var offset = 0
        for line in lines {
            var newLine = line
            let indent = line.prefix { $0 == " " || $0 == "\t" }.count
            if let p = linePrefix(line) {
                open.removeAll { $0.indent > indent }
                if p.ordered, let n = p.number {
                    let number: Int
                    if let k = open.lastIndex(where: { $0.indent == indent }) {
                        number = open[k].next
                        open[k].next += 1
                    } else {
                        // A top-level list keeps its first number; a nested one starts at 1.
                        number = indent == 0 ? n : 1
                        open.append((indent, number + 1))
                    }
                    if number != n {
                        let digits = String(line.dropFirst(indent).prefix { $0.isNumber })
                        let at = offset + indent
                        newLine = String(line.prefix(indent)) + String(number) + String(line.dropFirst(indent + digits.count))
                        let delta = (String(number) as NSString).length - (digits as NSString).length
                        if location > at { location = max(at, location + delta) }
                        if end > at { end = max(at, end + delta) }
                    }
                } else {
                    open.removeAll { $0.indent >= indent }
                }
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty || indent == 0 {
                // A blank line or an unindented paragraph closes every list.
                open.removeAll()
            }
            out.append(newLine)
            offset += (newLine as NSString).length + 1
        }
        return MarkdownEdit(text: out.joined(separator: "\n"), location: location, length: max(0, end - location))
    }

    // MARK: Tables

    /// A 2×2 skeleton on lines of its own, the caret in the first header cell.
    public static func insertTable(_ text: String, selection: NSRange) -> MarkdownEdit {
        let s = text as NSString
        let skeleton = "|  |  |\n| --- | --- |\n|  |  |"
        let before = selection.location > 0 && s.substring(with: NSRange(location: selection.location - 1, length: 1)) != "\n" ? "\n\n" : ""
        let afterIndex = selection.location + selection.length
        let after = afterIndex < s.length && s.substring(with: NSRange(location: afterIndex, length: 1)) != "\n" ? "\n" : ""
        let out = s.replacingCharacters(in: selection, with: before + skeleton + after)
        return MarkdownEdit(text: out, location: selection.location + (before as NSString).length + 2)
    }

    /// The lines of the table the caret is in (the header, its divider, its rows), or nil.
    public static func tableLines(_ text: String, at location: Int) -> NSRange? {
        let s = text as NSString
        let here = s.lineRange(for: NSRange(location: min(location, s.length), length: 0))
        func isRow(_ r: NSRange) -> Bool { s.substring(with: r).contains("|") }
        guard isRow(here) else { return nil }
        var first = here, last = here
        while first.location > 0 {
            let prev = s.lineRange(for: NSRange(location: first.location - 1, length: 0))
            guard isRow(prev) else { break }
            first = prev
        }
        while NSMaxRange(last) < s.length {
            let next = s.lineRange(for: NSRange(location: NSMaxRange(last), length: 0))
            guard isRow(next) else { break }
            last = next
        }
        let range = NSRange(location: first.location, length: NSMaxRange(last) - first.location)
        let lines = s.substring(with: range).components(separatedBy: "\n").filter { !$0.isEmpty }
        guard lines.count >= 2, MarkdownParser.parse(lines.prefix(2).joined(separator: "\n") + "\n").first.map(isTable) == true else { return nil }
        return range
    }

    private static func isTable(_ b: MarkdownBlock) -> Bool { if case .table = b { return true } else { return false } }

    /// A row below the caret's row (below the divider when the caret is in the header), caret in its first cell.
    public static func addRow(_ text: String, selection: NSRange) -> MarkdownEdit? {
        guard let table = tableLines(text, at: selection.location) else { return nil }
        let s = text as NSString
        let header = s.lineRange(for: NSRange(location: table.location, length: 0))
        let divider = s.lineRange(for: NSRange(location: NSMaxRange(header), length: 0))
        var row = s.lineRange(for: NSRange(location: selection.location, length: 0))
        if row.location < NSMaxRange(divider) { row = divider }
        let columns = MarkdownParser.cells(s.substring(with: header).trimmingCharacters(in: .newlines)).count
        let newRow = "|" + String(repeating: "  |", count: columns)
        let rowText = s.substring(with: row)
        let insertAt = NSMaxRange(row)
        let insert = rowText.hasSuffix("\n") ? newRow + "\n" : "\n" + newRow
        let out = s.replacingCharacters(in: NSRange(location: insertAt, length: 0), with: insert)
        let lineStart = rowText.hasSuffix("\n") ? insertAt : insertAt + 1
        return MarkdownEdit(text: out, location: lineStart + 2)
    }

    /// A column at the right of every row of the caret's table, caret in its header cell.
    public static func addColumn(_ text: String, selection: NSRange) -> MarkdownEdit? {
        guard let table = tableLines(text, at: selection.location) else { return nil }
        let s = text as NSString
        let lines = s.substring(with: table).components(separatedBy: "\n")
        var headerCell = 0
        var offset = table.location
        let updated = lines.enumerated().map { i, line -> String in
            guard !line.isEmpty else { return line }
            let trimmed = line.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
            let closed = trimmed.hasSuffix("|")
            let added = (closed ? "" : " |") + (i == 1 ? " --- |" : "  |")
            let out = trimmed + added
            if i == 0 { headerCell = offset + (out as NSString).length - 2 }
            offset += (line as NSString).length + 1
            return out
        }
        let out = s.replacingCharacters(in: table, with: updated.joined(separator: "\n"))
        return MarkdownEdit(text: out, location: headerCell)
    }

    /// Tab in a table: the caret to the next cell, then the next row's first
    /// (past the divider); from the last cell, a new row. Nil outside a table.
    public static func nextCell(_ text: String, selection: NSRange) -> MarkdownEdit? {
        guard let table = tableLines(text, at: selection.location) else { return nil }
        let s = text as NSString
        let line = s.lineRange(for: NSRange(location: selection.location, length: 0))
        let pipes = pipePositions(s, in: line)
        let caret = selection.location + selection.length
        if let end = pipes.first(where: { $0 >= caret }), end != pipes.last {
            return MarkdownEdit(text: text, location: cellStart(s, after: end))
        }
        // The next row, past the divider.
        var next = NSMaxRange(line)
        let header = s.lineRange(for: NSRange(location: table.location, length: 0))
        if line.location == header.location, next < NSMaxRange(table) {
            next = NSMaxRange(s.lineRange(for: NSRange(location: next, length: 0)))
        }
        if next < NSMaxRange(table) {
            let row = s.lineRange(for: NSRange(location: next, length: 0))
            if let first = pipePositions(s, in: row).first { return MarkdownEdit(text: text, location: cellStart(s, after: first)) }
        }
        return addRow(text, selection: NSRange(location: caret, length: 0))
    }

    private static func pipePositions(_ s: NSString, in line: NSRange) -> [Int] {
        var out: [Int] = []
        var i = line.location
        while i < NSMaxRange(line) {
            let c = s.character(at: i)
            if c == 0x5C { i += 2; continue } // a backslash escapes the next character
            if c == 0x7C { out.append(i) }
            i += 1
        }
        return out
    }

    /// Just inside a cell: after its pipe and one space.
    private static func cellStart(_ s: NSString, after pipe: Int) -> Int {
        pipe + 1 < s.length && s.character(at: pipe + 1) == 0x20 ? pipe + 2 : pipe + 1
    }

    // MARK: Helpers

    private static func mark(_ action: MarkdownAction) -> String? {
        switch action {
        case .bold: return "**"
        case .italic: return "*"
        case .strike: return "~~"
        case .code: return "`"
        default: return nil
        }
    }

    /// The lines the selection touches, without the last line's newline.
    static func block(_ s: NSString, _ start: Int, _ end: Int) -> (Int, Int) {
        let from = start == 0 ? 0 : s.lineRange(for: NSRange(location: start, length: 0)).location
        let lastLine = s.lineRange(for: NSRange(location: max(start, end - (end > start ? 1 : 0)), length: 0))
        var to = NSMaxRange(lastLine)
        if to > from, to <= s.length, to > 0, s.substring(with: NSRange(location: to - 1, length: 1)) == "\n" { to -= 1 }
        return (from, max(from, to))
    }

    /// The inline span (inside its marks) that holds the selection, if any.
    static func inlineSpan(_ s: NSString, _ start: Int, _ end: Int, _ mark: String) -> (from: Int, to: Int)? {
        let m = (mark as NSString).length
        if start == end, start >= m, end + m <= s.length,
           s.substring(with: NSRange(location: start - m, length: m)) == mark, s.substring(with: NSRange(location: end, length: m)) == mark {
            return (start, end)
        }
        let escaped = NSRegularExpression.escapedPattern(for: mark)
        guard let re = try? NSRegularExpression(pattern: "\(escaped)[^\\n]+?\(escaped)") else { return nil }
        for match in re.matches(in: s as String, range: NSRange(location: 0, length: s.length)) {
            let from = match.range.location + m
            let to = NSMaxRange(match.range) - m
            // A single * must not take a ** for its own marks.
            if m == 1 {
                let c = Character(mark)
                func at(_ i: Int) -> Character? { i >= 0 && i < s.length ? Character(s.substring(with: NSRange(location: i, length: 1))) : nil }
                if at(from) == c || at(to - 1) == c || at(match.range.location - 1) == c { continue }
            }
            if start >= from && end <= to { return (from, to) }
        }
        return nil
    }

    /// The length of a link's `](…)` right after `end`, if there is one.
    static func linkTail(_ s: NSString, _ end: Int) -> Int? {
        let rest = s.substring(from: end)
        guard let r = rest.range(of: #"^\]\([^\n)]*\)"#, options: .regularExpression) else { return nil }
        return (String(rest[r]) as NSString).length
    }

    static func matchesPrefix(_ action: MarkdownAction, _ line: String) -> Bool {
        let pattern: String
        switch action {
        case .heading: pattern = #"^#{1,6} "#
        case .bullet: pattern = #"^[-+*] (?!\[[ xX]\] )"#
        case .ordered: pattern = #"^\d+[.)] "#
        case .task: pattern = #"^[-+*] \[[ xX]\] "#
        case .quote: pattern = #"^> "#
        default: return false
        }
        return line.range(of: pattern, options: .regularExpression) != nil
    }

    static func stripPrefix(_ body: String) -> String {
        guard let r = body.range(of: #"^(?:#{1,6} |[-+*] (?:\[[ xX]\] )?|\d+[.)] |> )"#, options: .regularExpression) else { return body }
        return String(body[r.upperBound...])
    }

    struct LinePrefix {
        var indent: String
        /// The indent and marker, as typed.
        var full: String
        /// What the next line starts with after the indent.
        var next: String
        var ordered: Bool
        var number: Int?
    }

    /// A list or quote line's marker: `- `, `* `, `- [x] `, `3. `, `2) `, `> `.
    static func linePrefix(_ line: String) -> LinePrefix? {
        let indent = String(line.prefix { $0 == " " || $0 == "\t" })
        let body = String(line.dropFirst(indent.count))
        func match(_ p: String) -> String? { body.range(of: p, options: .regularExpression).map { String(body[$0]) } }
        if let m = match(#"^[-+*] \[[ xX]\] ?"#) {
            return LinePrefix(indent: indent, full: indent + m, next: String(m.prefix(1)) + " [ ] ", ordered: false, number: nil)
        }
        if let m = match(#"^[-+*] "#) { return LinePrefix(indent: indent, full: indent + m, next: m, ordered: false, number: nil) }
        if let m = match(#"^\d{1,9}[.)] "#) {
            let n = Int(m.prefix { $0.isNumber }) ?? 1
            let delimiter = m.dropFirst(String(n).count).prefix(1)
            return LinePrefix(indent: indent, full: indent + m, next: "\(n + 1)\(delimiter) ", ordered: true, number: n)
        }
        if let m = match(#"^> ?"#) { return LinePrefix(indent: indent, full: indent + m, next: "> ", ordered: false, number: nil) }
        return nil
    }
}
