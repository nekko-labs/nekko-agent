import Foundation

/// *Paste as Markdown* (MD-4): rich clipboard HTML (Safari, Mail, Notes via
/// RTF, Google Docs) turned into the Markdown the composer keeps as source.
///
/// A small tolerant HTML reader in pure Swift: the HTML is never loaded into a
/// web view or `NSAttributedString`, so nothing in it runs or is fetched.
/// Scripts, styles, frames, objects, images and SVG are dropped with their
/// content; only `http(s):` and `mailto:` links are kept. Mirrors the
/// desktop's `clipboardMarkdown` and adds nested lists and simple tables.
public enum RichPaste {
    /// Clipboard HTML bigger than this pastes as its plain text instead.
    public static let maxHTML = 2_000_000

    /// The Markdown for `html`, or `plain` (newlines normalised) when there is
    /// no HTML or it holds no text.
    public static func markdown(html: String?, plain: String) -> String {
        let fallback = plain.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        guard let html, !html.isEmpty, html.utf8.count <= maxHTML else { return fallback }
        let root = HTMLReader(html).parse()
        var w = Writer()
        let body = root.find("body") ?? root
        let md = w.blocks(body.children, indent: "")
        let tidy = tidyUp(md)
        return tidy.isEmpty ? fallback : tidy
    }

    /// At most one blank line in a row, no trailing spaces, trimmed.
    static func tidyUp(_ s: String) -> String {
        var lines = s.components(separatedBy: "\n").map { $0.replacingOccurrences(of: #"[ \t]+$"#, with: "", options: .regularExpression) }
        var out: [String] = []
        for l in lines where !(l.isEmpty && (out.last?.isEmpty ?? true)) { out.append(l) }
        lines = out
        while lines.last?.isEmpty == true { lines.removeLast() }
        return lines.joined(separator: "\n")
    }

    // MARK: Writing Markdown

    struct Writer {
        /// Elements dropped with everything inside them.
        static let dropped: Set<String> = ["script", "style", "iframe", "object", "embed", "img", "svg", "math", "noscript",
                                            "template", "head", "title", "meta", "link", "canvas", "video", "audio",
                                            "picture", "source", "form", "input", "button", "select", "textarea"]
        static let blockTags: Set<String> = ["p", "div", "section", "article", "header", "footer", "main", "aside", "nav",
                                              "ul", "ol", "li", "blockquote", "pre", "table", "h1", "h2", "h3", "h4", "h5", "h6",
                                              "hr", "dl", "dt", "dd", "figure", "figcaption", "address", "details", "summary"]

        /// Block-level content: paragraphs separated by a blank line, each line under `indent`.
        mutating func blocks(_ nodes: [HTMLNode], indent: String) -> String {
            var parts: [String] = []
            var inline: [HTMLNode] = []
            func flushInline() {
                let text = inlineText(inline).components(separatedBy: "\n")
                    .map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(text) }
                inline = []
            }
            for n in nodes {
                if case .element(let e) = n {
                    if Self.dropped.contains(e.tag) { continue }
                    let b: String
                    if Self.blockTags.contains(e.tag) {
                        b = block(e, indent: indent)
                    } else if Self.holdsBlocks(e) {
                        // An inline wrapper around blocks (Google Docs puts everything in one <b>): see through it.
                        b = blocks(e.children, indent: indent)
                    } else {
                        inline.append(n)
                        continue
                    }
                    flushInline()
                    if !b.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append(b) }
                } else {
                    inline.append(n)
                }
            }
            flushInline()
            return parts.joined(separator: "\n\n")
        }

        mutating func block(_ e: HTMLElement, indent: String) -> String {
            switch e.tag {
            case "h1", "h2", "h3", "h4", "h5", "h6":
                let level = Int(String(e.tag.dropFirst())) ?? 1
                return String(repeating: "#", count: level) + " " + oneLine(inlineText(e.children))
            case "hr":
                return "---"
            case "pre":
                let code = e.textContent.replacingOccurrences(of: "\r\n", with: "\n")
                let lang = e.find("code")?.attributes["class"].flatMap { c in
                    c.split(separator: " ").first { $0.hasPrefix("language-") }.map { String($0.dropFirst(9)) }
                } ?? ""
                let body = code.hasSuffix("\n") ? String(code.dropLast()) : code
                let fence = body.contains("```") ? "~~~" : "```"
                return fence + lang + "\n" + body + "\n" + fence
            case "blockquote":
                let inner = blocks(e.children, indent: "")
                return inner.components(separatedBy: "\n").map { $0.isEmpty ? ">" : "> " + $0 }.joined(separator: "\n")
            case "ul", "ol":
                return list(e, indent: indent)
            case "li":
                // A stray item outside a list.
                return "- " + blocks(e.children, indent: indent + "  ")
            case "table":
                return table(e)
            default:
                return blocks(e.children, indent: indent)
            }
        }

        /// A list, nested lists indented under their item's text.
        mutating func list(_ e: HTMLElement, indent: String) -> String {
            let ordered = e.tag == "ol"
            var n = Int(e.attributes["start"] ?? "") ?? 1
            var lines: [String] = []
            for child in e.children {
                guard case .element(let li) = child else { continue }
                if li.tag == "ul" || li.tag == "ol" {
                    // A list directly inside a list (as some editors write it) nests under the previous item.
                    lines.append(list(li, indent: indent + (ordered ? "   " : "  ")))
                    continue
                }
                guard li.tag == "li" else { continue }
                let marker = ordered ? "\(n). " : "- "
                n += 1
                let hang = indent + String(repeating: " ", count: marker.count)
                var textNodes: [HTMLNode] = []
                var nested: [String] = []
                for c in li.children {
                    if case .element(let sub) = c, sub.tag == "ul" || sub.tag == "ol" {
                        nested.append(list(sub, indent: hang))
                    } else {
                        textNodes.append(c)
                    }
                }
                var task = ""
                if let box = li.find("input"), box.attributes["type"]?.lowercased() == "checkbox" {
                    task = box.attributes["checked"] != nil ? "[x] " : "[ ] "
                }
                let body = blocks(textNodes, indent: hang)
                    .components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                var itemLines = [indent + marker + task + (body.first ?? "")]
                itemLines += body.dropFirst().map { hang + $0 }
                lines.append(itemLines.joined(separator: "\n"))
                lines += nested
            }
            return lines.joined(separator: "\n")
        }

        /// Rows of `th`/`td` cells as a pipe table, the first row as its header.
        mutating func table(_ e: HTMLElement) -> String {
            var rows: [[String]] = []
            func collect(_ el: HTMLElement) {
                for c in el.children {
                    guard case .element(let x) = c else { continue }
                    if x.tag == "tr" {
                        let cells = x.children.compactMap { n -> String? in
                            guard case .element(let cell) = n, cell.tag == "td" || cell.tag == "th" else { return nil }
                            return oneLine(inlineText(cell.children)).replacingOccurrences(of: "|", with: "\\|")
                        }
                        if !cells.isEmpty { rows.append(cells) }
                    } else if ["thead", "tbody", "tfoot"].contains(x.tag) {
                        collect(x)
                    }
                }
            }
            collect(e)
            guard let header = rows.first else { return "" }
            let width = rows.map(\.count).max() ?? header.count
            func row(_ r: [String]) -> String {
                "| " + (r + Array(repeating: "", count: width - r.count)).joined(separator: " | ") + " |"
            }
            let divider = "| " + Array(repeating: "---", count: width).joined(separator: " | ") + " |"
            return ([row(header), divider] + rows.dropFirst().map(row)).joined(separator: "\n")
        }

        // MARK: Inline

        func inlineText(_ nodes: [HTMLNode]) -> String {
            var out = ""
            for n in nodes { out += inline(n) }
            // Collapsed HTML whitespace, but the line breaks a <br> made stay.
            return out.components(separatedBy: "\n").map { line in
                line.replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
            }.joined(separator: "\n")
        }

        func inline(_ n: HTMLNode) -> String {
            switch n {
            case .text(let t):
                return escape(t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression))
            case .element(let e):
                if Self.dropped.contains(e.tag) { return "" }
                let inner = inlineText(e.children)
                let style = (e.attributes["style"] ?? "").lowercased().replacingOccurrences(of: " ", with: "")
                switch e.tag {
                case "br": return "\n"
                case "strong", "b":
                    // Google Docs wraps everything in <b style="font-weight:normal">.
                    if style.contains("font-weight:normal") || style.contains("font-weight:400") { return inner }
                    return wrap(inner, "**")
                case "em", "i", "cite": return wrap(inner, "*")
                case "s", "del", "strike": return wrap(inner, "~~")
                case "code", "kbd", "samp", "tt":
                    let t = e.textContent
                    return t.contains("`") ? "`` " + t + " ``" : "`" + t + "`"
                case "a":
                    let href = (e.attributes["href"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    guard Self.safeLink(href) else { return inner }
                    let url = href.replacingOccurrences(of: "(", with: "%28").replacingOccurrences(of: ")", with: "%29")
                        .replacingOccurrences(of: " ", with: "%20")
                    let label = inner.trimmingCharacters(in: .whitespaces)
                    return "[" + (label.isEmpty ? escape(href) : label) + "](" + url + ")"
                case "span", "font":
                    var out = inner
                    if style.contains("font-weight:bold") || style.contains("font-weight:700") || style.contains("font-weight:600") { out = wrap(out, "**") }
                    if style.contains("font-style:italic") { out = wrap(out, "*") }
                    if style.contains("line-through") { out = wrap(out, "~~") }
                    return out
                default:
                    if Self.blockTags.contains(e.tag) { return "\n" + inner + "\n" }
                    return inner
                }
            }
        }

        /// Marks around the text, with its outer spaces kept outside them (`** bold**` isn't bold).
        func wrap(_ s: String, _ mark: String) -> String {
            let core = s.trimmingCharacters(in: .whitespaces)
            guard !core.isEmpty else { return s }
            let lead = s.prefix { $0 == " " }, trail = String(s.reversed().prefix { $0 == " " })
            return lead + mark + core + mark + trail
        }

        func oneLine(_ s: String) -> String {
            s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        }

        /// Markdown's own characters in text are escaped, so pasted prose stays prose.
        func escape(_ s: String) -> String {
            var out = ""
            for ch in s {
                if "\\`*_[]~".contains(ch) { out.append("\\") }
                out.append(ch)
            }
            return out
        }

        static func holdsBlocks(_ e: HTMLElement) -> Bool {
            e.children.contains { n in
                guard case .element(let c) = n, !dropped.contains(c.tag) else { return false }
                return blockTags.contains(c.tag) || holdsBlocks(c)
            }
        }

        static func safeLink(_ href: String) -> Bool {
            let lower = href.lowercased()
            return lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:")
        }
    }
}

// MARK: - A tolerant HTML reader

indirect enum HTMLNode {
    case text(String)
    case element(HTMLElement)
}

final class HTMLElement {
    let tag: String
    var attributes: [String: String]
    var children: [HTMLNode] = []

    init(tag: String, attributes: [String: String] = [:]) {
        self.tag = tag
        self.attributes = attributes
    }

    var textContent: String {
        children.map { n -> String in
            switch n {
            case .text(let t): return t
            case .element(let e): return RichPaste.Writer.dropped.contains(e.tag) ? "" : (e.tag == "br" ? "\n" : e.textContent)
            }
        }.joined()
    }

    /// The first descendant (or self) with this tag.
    func find(_ tag: String) -> HTMLElement? {
        if self.tag == tag { return self }
        for case .element(let e) in children { if let hit = e.find(tag) { return hit } }
        return nil
    }
}

/// Reads HTML into a tree the way browsers roughly do: unknown or mismatched
/// closing tags are tolerated, `<p>` and `<li>` close themselves, void
/// elements have no content, and `<script>`/`<style>` bodies are skipped
/// unread. Comments, doctypes and processing instructions are ignored.
struct HTMLReader {
    static let void: Set<String> = ["br", "hr", "img", "meta", "link", "input", "area", "base", "col", "embed", "source", "track", "wbr", "param"]
    static let rawText: Set<String> = ["script", "style", "textarea", "title", "xmp", "noscript", "template", "iframe"]

    let chars: [Character]
    init(_ html: String) { chars = Array(html) }

    func parse() -> HTMLElement {
        let root = HTMLElement(tag: "#root")
        var stack: [HTMLElement] = [root]
        var i = 0
        var text = ""
        func flushText() {
            if !text.isEmpty { stack.last!.children.append(.text(Self.decode(text))) }
            text = ""
        }
        func close(_ tag: String) {
            guard let k = stack.lastIndex(where: { $0.tag == tag }), k > 0 else { return }
            stack.removeSubrange(k...)
        }
        while i < chars.count {
            let c = chars[i]
            guard c == "<", i + 1 < chars.count else { text.append(c); i += 1; continue }
            let next = chars[i + 1]
            if next == "!" || next == "?" {
                flushText()
                if starts("<!--", at: i) {
                    i = find("-->", from: i + 4).map { $0 + 3 } ?? chars.count
                } else {
                    i = find(">", from: i).map { $0 + 1 } ?? chars.count
                }
                continue
            }
            if next == "/" {
                flushText()
                let end = find(">", from: i) ?? chars.count
                let name = String(chars[(i + 2)..<end]).trimmingCharacters(in: .whitespaces).lowercased()
                close(name)
                i = min(chars.count, end + 1)
                continue
            }
            guard next.isLetter else { text.append(c); i += 1; continue }
            flushText()
            let (tag, attrs, selfClosing, end) = readTag(from: i + 1)
            i = end
            // Implicitly closed: a new <p> or block closes an open <p>; a new <li> closes the open <li>; same for rows and cells.
            if tag == "li" { closeOpen("li", within: ["ul", "ol"], stack: &stack) }
            if tag == "tr" { closeOpen("tr", within: ["table", "thead", "tbody", "tfoot"], stack: &stack) }
            if tag == "td" || tag == "th" { closeOpen("td", within: ["tr"], stack: &stack); closeOpen("th", within: ["tr"], stack: &stack) }
            if RichPaste.Writer.blockTags.contains(tag), stack.last?.tag == "p" { stack.removeLast() }
            let el = HTMLElement(tag: tag, attributes: attrs)
            stack.last!.children.append(.element(el))
            if Self.rawText.contains(tag) {
                // Skipped unread: its body is never parsed as markup.
                let closeTag = "</" + tag
                var j = i
                while j < chars.count, !startsCaseInsensitive(closeTag, at: j) { j += 1 }
                i = find(">", from: j).map { $0 + 1 } ?? chars.count
                continue
            }
            if !selfClosing && !Self.void.contains(tag) { stack.append(el) }
        }
        flushText()
        return root
    }

    private func closeOpen(_ tag: String, within boundaries: Set<String>, stack: inout [HTMLElement]) {
        guard let k = stack.lastIndex(where: { $0.tag == tag || boundaries.contains($0.tag) }), stack[k].tag == tag, k > 0 else { return }
        stack.removeSubrange(k...)
    }

    private func readTag(from start: Int) -> (String, [String: String], Bool, Int) {
        var i = start
        var name = ""
        while i < chars.count, !chars[i].isWhitespace, chars[i] != ">", chars[i] != "/" { name.append(chars[i]); i += 1 }
        var attrs: [String: String] = [:]
        var selfClosing = false
        while i < chars.count {
            let c = chars[i]
            if c == ">" { i += 1; break }
            if c == "/" { selfClosing = true; i += 1; continue }
            if c.isWhitespace { i += 1; continue }
            selfClosing = false
            var key = ""
            while i < chars.count, !chars[i].isWhitespace, chars[i] != "=", chars[i] != ">", chars[i] != "/" { key.append(chars[i]); i += 1 }
            while i < chars.count, chars[i].isWhitespace { i += 1 }
            var value = ""
            if i < chars.count, chars[i] == "=" {
                i += 1
                while i < chars.count, chars[i].isWhitespace { i += 1 }
                if i < chars.count, chars[i] == "\"" || chars[i] == "'" {
                    let q = chars[i]
                    i += 1
                    while i < chars.count, chars[i] != q { value.append(chars[i]); i += 1 }
                    i += 1
                } else {
                    while i < chars.count, !chars[i].isWhitespace, chars[i] != ">" { value.append(chars[i]); i += 1 }
                }
            }
            if !key.isEmpty { attrs[key.lowercased()] = Self.decode(value) }
        }
        return (name.lowercased(), attrs, selfClosing, i)
    }

    private func starts(_ s: String, at i: Int) -> Bool {
        let p = Array(s)
        guard i + p.count <= chars.count else { return false }
        return Array(chars[i..<(i + p.count)]) == p
    }

    private func startsCaseInsensitive(_ s: String, at i: Int) -> Bool {
        let p = Array(s.lowercased())
        guard i + p.count <= chars.count else { return false }
        return chars[i..<(i + p.count)].map { Character($0.lowercased()) } == p
    }

    private func find(_ s: String, from i: Int) -> Int? {
        var j = i
        while j < chars.count { if starts(s, at: j) { return j }; j += 1 }
        return nil
    }

    static let entities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "mdash": "—", "ndash": "–",
        "hellip": "…", "rsquo": "’", "lsquo": "‘", "rdquo": "”", "ldquo": "“", "bull": "•", "copy": "©", "reg": "®",
        "trade": "™", "middot": "·", "times": "×", "rarr": "→", "larr": "←", "deg": "°", "euro": "€",
    ]

    /// `&amp;`, `&#39;`, `&#x1F600;` and the common named entities.
    static func decode(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == "&", let semi = s[i...].prefix(12).firstIndex(of: ";") {
                let name = String(s[s.index(after: i)..<semi])
                var replacement: String?
                if name.hasPrefix("#x") || name.hasPrefix("#X") {
                    replacement = UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
                } else if name.hasPrefix("#") {
                    replacement = UInt32(name.dropFirst()).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
                } else {
                    replacement = entities[name]
                }
                if let replacement {
                    out += replacement
                    i = s.index(after: semi)
                    continue
                }
            }
            out.append(s[i])
            i = s.index(after: i)
        }
        return out
    }
}
