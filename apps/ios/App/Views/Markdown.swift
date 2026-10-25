import NekkoProtocol
import SwiftUI
import UIKit

/// Enough Markdown for agent replies, without a dependency: fenced code
/// blocks (scrollable, monospaced, copyable), headings, bullet and numbered
/// lists, quotes, rules, pipe tables, and inline styling (bold, italic, code,
/// links) via `AttributedString(markdown:)`. The blocks are parsed in the
/// package (`MarkdownBlocks`). Links are never fetched here: a tap goes to the
/// `openURL` action, which the chat routes (`ChatLinks`, `PreviewWindow`).
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
                        .accessibilityAddTraits(.isHeader)
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
                case .table(let t):
                    MarkdownTableView(table: t)
                }
            }
        }
        .textSelection(.enabled)
    }

    private func inline(_ s: String) -> Text {
        if let a = InlineMarkdown.attributed(s) { return Text(a) }
        return Text(s)
    }

    static func parse(_ text: String) -> [LegacyMarkdownBlock] { MarkdownBlocks.parse(text) }
}

/// A pipe table: the header semibold on a faint fill, hairlines between rows,
/// columns aligned as the `:---:` row says. A wide table scrolls sideways in
/// its own frame; a long cell wraps at a width cap instead of widening it.
struct MarkdownTableView: View {
    let table: MarkdownTable
    @Environment(\.palette) private var palette
    @ScaledMetric(relativeTo: .subheadline) private var cellCap: CGFloat = 260

    var body: some View {
        // What VoiceOver reads and Copy copies: the cells without Markdown marks.
        let spoken = MarkdownTable(header: table.header.map(InlineMarkdown.plain), alignments: table.alignments,
                                   rows: table.rows.map { $0.map(InlineMarkdown.plain) })
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(table.header.indices, id: \.self) { c in
                        cell(table.header[c], column: c, header: true)
                            .accessibilityLabel(spoken.accessibilityLabel(row: 0, column: c))
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                ForEach(table.rows.indices, id: \.self) { r in
                    Rectangle().fill(palette.line).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                        .accessibilityHidden(true)
                    GridRow {
                        ForEach(table.header.indices, id: \.self) { c in
                            cell(table.rows[r][c], column: c, header: false)
                                .accessibilityLabel(spoken.accessibilityLabel(row: r + 1, column: c))
                        }
                    }
                }
            }
        }
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.line))
        .contextMenu {
            Button { UIPasteboard.general.string = Self.tabSeparated(spoken) } label: { Label("Copy table", systemImage: "doc.on.doc") }
        }
    }

    private func cell(_ s: String, column c: Int, header: Bool) -> some View {
        let align = table.alignments.indices.contains(c) ? table.alignments[c] : .leading
        let text = InlineMarkdown.attributed(s).map { Text($0) } ?? Text(s)
        let frameAlign: Alignment = align == .center ? .top : align == .trailing ? .topTrailing : .topLeading
        return CappedWidth(cap: cellCap) {
            text.font(header ? .subheadline.weight(.semibold) : .subheadline)
                .foregroundStyle(palette.ink)
                .multilineTextAlignment(align == .center ? .center : align == .trailing ? .trailing : .leading)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: frameAlign)
        .background(header ? palette.surface2 : Color.clear)
    }

    /// Pastes into Numbers or Sheets as cells.
    static func tabSeparated(_ t: MarkdownTable) -> String {
        ([t.header] + t.rows).map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }
}

/// Its content at its natural width up to `cap`, wrapping beyond that. A
/// horizontal scroll view offers unlimited width, so a plain frame can't wrap.
struct CappedWidth: Layout {
    let cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let v = subviews.first else { return .zero }
        let w = min(v.sizeThatFits(.unspecified).width, cap)
        return CGSize(width: w, height: v.sizeThatFits(ProposedViewSize(width: w, height: nil)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
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
                    AccessibilityNotification.Announcement("Copied").post()
                    Task { try? await Task.sleep(nanoseconds: 1_200_000_000); copied = false }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
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

/// Inline Markdown, parsed once per distinct string. While a reply streams,
/// every token re-renders the whole reply; without this each finished paragraph
/// went through `AttributedString(markdown:)` again on every token.
enum InlineMarkdown {
    private final class Box {
        let value: AttributedString?
        init(_ value: AttributedString?) { self.value = value }
    }

    private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 800
        return c
    }()

    private static let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)

    static func attributed(_ s: String) -> AttributedString? {
        let key = s as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        // Paths Markdown can't read as URLs (`C:\x\y.html`, spaces) become `file:` links first.
        let value = try? AttributedString(markdown: ChatLinks.linkable(s), options: options)
        cache.setObject(Box(value), forKey: key)
        return value
    }

    /// The text without Markdown marks, for VoiceOver and copying.
    static func plain(_ s: String) -> String {
        attributed(s).map { String($0.characters) } ?? s
    }
}
