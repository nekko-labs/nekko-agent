import Foundation

/// The blocks of an agent reply, as the phone draws them (`MarkdownText`):
/// fenced code, headings, bullet and numbered lists, quotes, rules, GitHub
/// pipe tables and paragraphs. Inline styling inside each block is left to
/// `AttributedString(markdown:)` in the app.
public enum LegacyMarkdownBlock: Equatable, Sendable {
    /// Language, then the code as written.
    case code(String, String)
    case heading(Int, String)
    /// Indent level, marker (`•`, `☐`, `☑`, `1.`), text.
    case bullet(Int, String, String)
    case quote(String)
    case rule
    case paragraph(String)
    case table(MarkdownTable)
}

public enum MarkdownBlocks {
    public static func parse(_ text: String) -> [LegacyMarkdownBlock] {
        var out: [LegacyMarkdownBlock] = []
        var para: [String] = []
        var fence: (lang: String, lines: [String])?
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))) }
            para = []
        }
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            i += 1
            let line = raw.trimmingCharacters(in: .whitespaces)
            if var f = fence {
                if line.hasPrefix("```") {
                    out.append(.code(f.lang, f.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    f.lines.append(raw)
                    fence = f
                }
                continue
            }
            if line.hasPrefix("```") {
                flush()
                fence = (String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces), [])
                continue
            }
            if line.isEmpty { flush(); continue }
            // A table: a header row, then a delimiter row with as many cells.
            if i < lines.count, let header = row(line), let aligns = delimiter(lines[i].trimmingCharacters(in: .whitespaces)),
               aligns.count == header.count {
                flush()
                i += 1
                var rows: [[String]] = []
                while i < lines.count {
                    let next = lines[i].trimmingCharacters(in: .whitespaces)
                    guard !next.isEmpty, !next.hasPrefix("```"), let cells = row(next) else { break }
                    rows.append(fit(cells, header.count))
                    i += 1
                }
                out.append(.table(MarkdownTable(header: header, alignments: aligns, rows: rows)))
                continue
            }
            if let h = line.firstIndex(where: { $0 != "#" }), line.hasPrefix("#"), line[h] == " " {
                flush()
                out.append(.heading(line.distance(from: line.startIndex, to: h), String(line[h...]).trimmingCharacters(in: .whitespaces)))
                continue
            }
            if line == "---" || line == "***" || line == "___" { flush(); out.append(.rule); continue }
            if line.hasPrefix("> ") { flush(); out.append(.quote(String(line.dropFirst(2)))); continue }
            let indent = (raw.prefix { $0 == " " }.count) / 2
            if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
                flush()
                var body = String(line.dropFirst(2))
                var marker = "•"
                if body.hasPrefix("[ ] ") { marker = "☐"; body = String(body.dropFirst(4)) }
                if body.hasPrefix("[x] ") || body.hasPrefix("[X] ") { marker = "☑"; body = String(body.dropFirst(4)) }
                out.append(.bullet(indent, marker, body))
                continue
            }
            if let dot = line.firstIndex(of: "."), dot != line.startIndex, line[..<dot].allSatisfy(\.isNumber),
               line.index(after: dot) < line.endIndex, line[line.index(after: dot)] == " " {
                flush()
                out.append(.bullet(indent, String(line[...dot]), String(line[line.index(dot, offsetBy: 2)...])))
                continue
            }
            para.append(raw)
        }
        if let f = fence { out.append(.code(f.lang, f.lines.joined(separator: "\n"))) }
        flush()
        return out
    }

    /// A table row's cells, trimmed, with `\|` read as a literal pipe; nil
    /// when the line has no unescaped pipe. Leading and trailing pipes are optional.
    public static func row(_ line: String) -> [String]? {
        var cells: [String] = []
        var cell = ""
        var sawPipe = false
        var escaped = false
        for c in line {
            if escaped {
                // Only `\|` is ours; every other escape is left for the inline parser.
                if c != "|" { cell.append("\\") }
                cell.append(c)
                escaped = false
            } else if c == "\\" {
                escaped = true
            } else if c == "|" {
                sawPipe = true
                cells.append(cell)
                cell = ""
            } else {
                cell.append(c)
            }
        }
        if escaped { cell.append("\\") }
        guard sawPipe else { return nil }
        cells.append(cell)
        var trimmed = cells.map { $0.trimmingCharacters(in: .whitespaces) }
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|"), trimmed.first?.isEmpty == true { trimmed.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|"), trimmed.last?.isEmpty == true, !trimmed.isEmpty { trimmed.removeLast() }
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The delimiter row under a header (`| :--- | :---: | ---: |`): each
    /// cell's alignment, or nil when the line isn't one.
    public static func delimiter(_ line: String) -> [MarkdownTable.Alignment]? {
        guard line.contains("|"), let cells = row(line), !cells.isEmpty else { return nil }
        var out: [MarkdownTable.Alignment] = []
        for cell in cells {
            let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
            let dashes = cell.dropFirst(left ? 1 : 0).dropLast(right && cell.count > 1 ? 1 : 0)
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            out.append(left && right ? .center : right ? .trailing : .leading)
        }
        return out
    }

    /// A body row padded with empty cells, or cut, to the header's width.
    static func fit(_ cells: [String], _ n: Int) -> [String] {
        cells.count >= n ? Array(cells.prefix(n)) : cells + Array(repeating: "", count: n - cells.count)
    }
}
