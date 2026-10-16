import SwiftUI

/// Enough Markdown for agent replies, without a dependency: fenced code
/// blocks (scrollable, monospaced, copyable), headings, bullet and numbered
/// lists, quotes, rules, and inline styling (bold, italic, code, links) via
/// `AttributedString(markdown:)`. Links render but are never fetched.
struct MarkdownText: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.parse(text).enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .code(let lang, let body):
                    CodeBlock(language: lang, code: body)
                case .heading(let level, let s):
                    inline(s).font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                case .bullet(let indent, let marker, let s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker).foregroundStyle(palette.inkSoft).monospacedDigit()
                        inline(s)
                    }.padding(.leading, CGFloat(indent) * 14)
                case .quote(let s):
                    inline(s).foregroundStyle(palette.inkSoft).padding(.leading, 10)
                        .overlay(alignment: .leading) { Rectangle().fill(palette.line).frame(width: 3) }
                case .rule:
                    Divider()
                case .paragraph(let s):
                    inline(s)
                }
            }
        }
        .textSelection(.enabled)
    }

    private func inline(_ s: String) -> Text {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        if let a = try? AttributedString(markdown: s, options: opts) { return Text(a) }
        return Text(s)
    }

    enum Piece: Equatable {
        case code(String, String)
        case heading(Int, String)
        case bullet(Int, String, String)
        case quote(String)
        case rule
        case paragraph(String)
    }

    static func parse(_ text: String) -> [Piece] {
        var out: [Piece] = []
        var para: [String] = []
        var fence: (lang: String, lines: [String])?
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))) }
            para = []
        }
        for raw in text.components(separatedBy: "\n") {
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
}

struct CodeBlock: View {
    let language: String
    let code: String
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language).font(.caption2.monospaced()).foregroundStyle(palette.inkFaint)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task { try? await Task.sleep(nanoseconds: 1_200_000_000); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 10).padding(.top, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced)).foregroundStyle(palette.ink)
                    .padding(10).fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(palette.code, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.line))
    }
}
