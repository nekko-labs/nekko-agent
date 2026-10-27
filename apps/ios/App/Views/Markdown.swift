import NekkoProtocol
import SwiftUI
import UIKit

/// Chat Markdown, without a dependency: the block tree from `MarkdownParser`
/// (NekkoProtocol, tested on Linux) drawn natively. Fenced code (scrollable,
/// copyable), headings, real nested lists with markers by depth and task
/// checkboxes, native table grids (sideways scroll, Expand, copy actions),
/// quotes, rules, and inline styling via `AttributedString(markdown:)`.
/// Links render but are never fetched.
struct MarkdownText: View {
    let text: String
    /// Drawn inside the user's own bubble: secondary colours come from the bubble's ink.
    var bubble = false
    /// Long-press selects text (replies) rather than opening the bubble's menu (the user's own messages).
    var selectable = true
    @Environment(\.palette) private var palette

    var body: some View {
        let style = bubble ? MarkdownStyle.bubble(palette) : MarkdownStyle.standard(palette)
        MarkdownBlocks(blocks: MarkdownParser.blocks(text), style: style)
            .modifier(Selectable(on: selectable))
    }
}

/// The colours a Markdown body draws with besides its text, which comes from `foregroundStyle`.
struct MarkdownStyle {
    var soft: Color
    var faint: Color
    var line: Color
    var codeFill: Color
    var codeInk: Color
    var headerFill: Color
    var done: Color

    static func standard(_ p: Palette) -> MarkdownStyle {
        MarkdownStyle(soft: p.inkSoft, faint: p.inkFaint, line: p.line, codeFill: p.code, codeInk: p.ink,
                      headerFill: p.surface2, done: p.success)
    }

    /// On the accent-coloured bubble every tint is the bubble's own ink, faded.
    static func bubble(_ p: Palette) -> MarkdownStyle {
        MarkdownStyle(soft: p.userInk.opacity(0.85), faint: p.userInk.opacity(0.7), line: p.userInk.opacity(0.35),
                      codeFill: Color.black.opacity(0.18), codeInk: p.userInk, headerFill: p.userInk.opacity(0.14),
                      done: p.userInk)
    }
}

private struct Selectable: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.textSelection(.enabled) } else { content.textSelection(.disabled) }
    }
}

struct MarkdownBlocks: View {
    let blocks: [MarkdownBlock]
    let style: MarkdownStyle

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, style: style)
            }
        }
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let style: MarkdownStyle

    var body: some View {
        switch block {
        case .code(let lang, let code, let closed):
            if MermaidRules.isMermaid(language: lang) {
                MermaidBlock(source: code, closed: closed, style: style)
            } else {
                CodeBlock(language: lang, code: code, style: style)
            }
        case .heading(let level, let s):
            InlineText(s).font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
        case .list(let list):
            MarkdownListView(list: list, depth: 0, style: style)
        case .table(let table):
            MarkdownTableView(table: table, style: style)
        case .quote(let inner):
            MarkdownBlocks(blocks: inner, style: style)
                .foregroundStyle(style.soft)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(style.line).frame(width: 3) }
        case .rule:
            Rectangle().fill(style.line).frame(height: 1).padding(.vertical, 2).accessibilityHidden(true)
        case .paragraph(let s):
            InlineText(s)
        }
    }
}

/// Inline Markdown as one `Text`, parsed once per distinct string.
struct InlineText: View {
    let source: String
    init(_ source: String) { self.source = source }

    var body: some View {
        if let a = InlineMarkdown.attributed(source) { Text(a) } else { Text(source) }
    }
}

// MARK: - Lists

/// A list as a tree: the marker on the first line, the item's text and its
/// nested lists hanging beside it, so wrapped lines line up under the text.
struct MarkdownListView: View {
    let list: MarkdownList
    let depth: Int
    let style: MarkdownStyle

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { i, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    marker(item, number: list.start + i)
                    VStack(alignment: .leading, spacing: 4) {
                        if !item.text.isEmpty || item.children.isEmpty {
                            InlineText(item.text)
                                .opacity(item.task == .done ? 0.7 : 1)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                            MarkdownListView(list: child, depth: depth + 1, style: style)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func marker(_ item: MarkdownListItem, number: Int) -> some View {
        if let task = item.task {
            Image(systemName: task == .done ? "checkmark.square.fill" : "square")
                .foregroundStyle(task == .done ? style.done : style.faint)
                .accessibilityLabel(task == .done ? "Done" : "Not done")
        } else {
            // U+FE0E: the text glyph, not the emoji square iOS draws for a bare ▪.
            Text(MarkdownParser.marker(ordered: list.ordered, depth: depth, number: number) + (list.ordered ? "" : "\u{FE0E}"))
                .monospacedDigit()
                .foregroundStyle(style.soft)
                // Numbers line up on their dots; bullets get a narrow column.
                .frame(minWidth: list.ordered ? 18 : 10, alignment: list.ordered ? .trailing : .center)
                .accessibilityHidden(!list.ordered)
        }
    }
}

// MARK: - Tables

/// A pipe table as a native grid: bold header on a faint fill, hairlines
/// between rows, columns aligned as the `:---:` markers say. It scrolls
/// sideways inside its own frame; a big one also offers Expand.
struct MarkdownTableView: View {
    let table: MarkdownTable
    let style: MarkdownStyle
    @State private var expanded = false
    @State private var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: true) {
                // The frame hugs the grid: a narrow table doesn't get an empty box to the screen's edge.
                MarkdownTableGrid(table: table, style: style, cellCap: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(style.line))
                    .padding(1)
            }
            HStack(spacing: 12) {
                if table.isLarge {
                    Button { expanded = true } label: {
                        Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right").font(.caption)
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("markdown.table.expand")
                }
                if let copied { Text(copied).font(.caption2).foregroundStyle(style.faint) }
            }
            .foregroundStyle(style.soft)
        }
        .contextMenu {
            Button { copy(table.markdown, "Copied as Markdown") } label: { Label("Copy as Markdown", systemImage: "doc.on.doc") }
            Button { copy(table.tabSeparated, "Copied as text") } label: { Label("Copy as text", systemImage: "tablecells") }
            ShareLink(item: table.markdown) { Label("Share", systemImage: "square.and.arrow.up") }
        }
        .accessibilityElement(children: .contain)
        .fullScreenCover(isPresented: $expanded) { MarkdownTableScreen(table: table) }
    }

    private func copy(_ s: String, _ note: String) {
        UIPasteboard.general.string = s
        copied = note
        AccessibilityNotification.Announcement(note).post()
        Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = nil }
    }
}

struct MarkdownTableGrid: View {
    let table: MarkdownTable
    let style: MarkdownStyle
    /// Long cells wrap at this width instead of stretching their column.
    let cellCap: CGFloat
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(table.header.enumerated()), id: \.offset) { c, h in
                    cell(h, column: c).fontWeight(.semibold).background(style.headerFill)
                }
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(style.line).frame(height: 1 / displayScale)
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { c, value in cell(value, column: c) }
                }
            }
        }
        .font(.subheadline)
        // Its own natural size: cells fill their row and column, never the space offered.
        .fixedSize()
        // VoiceOver hears the table as rows: "Row 2 of 5: Name, Nekko; Status, done".
        .accessibilityRepresentation {
            VStack {
                Text("Table, \(table.header.count) columns, \(table.rows.count) rows")
                ForEach(table.rows.indices, id: \.self) { r in Text(table.accessibilityRow(r)) }
            }
        }
    }

    private func cell(_ s: String, column: Int) -> some View {
        let a = column < table.alignments.count ? table.alignments[column] : .leading
        let align: Alignment = a == .center ? .center : a == .trailing ? .trailing : .leading
        return CappedWidth(cap: cellCap) {
            InlineText(s).multilineTextAlignment(a == .center ? .center : a == .trailing ? .trailing : .leading)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: align)
    }
}

/// Its child at its natural width, but no wider than `cap` (where it wraps).
struct CappedWidth: Layout {
    let cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let s = subviews.first else { return .zero }
        let ideal = s.sizeThatFits(.unspecified)
        let width = min(ideal.width, cap)
        let height = s.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// A big table full screen: pinch to zoom, scroll both ways, the same copy actions.
struct MarkdownTableScreen: View {
    let table: MarkdownTable
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            ZoomableScrollView {
                MarkdownTableGrid(table: table, style: .standard(palette), cellCap: 320)
                    .foregroundStyle(palette.ink)
                    .padding(16)
                    .background(palette.paper)
            }
            .background(palette.paper)
            .navigationTitle("Table")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("markdown.table.done")
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { UIPasteboard.general.string = table.markdown } label: { Label("Copy as Markdown", systemImage: "doc.on.doc") }
                        Button { UIPasteboard.general.string = table.tabSeparated } label: { Label("Copy as text", systemImage: "tablecells") }
                        ShareLink(item: table.markdown) { Label("Share", systemImage: "square.and.arrow.up") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Table actions")
                }
            }
        }
    }
}

/// SwiftUI content in a UIKit scroll view: pinch to zoom, pan both ways, double-tap to reset.
struct ZoomableScrollView<Content: View>: UIViewRepresentable {
    var maxScale: CGFloat = 4
    @ViewBuilder var content: Content

    func makeCoordinator() -> Coordinator { Coordinator(host: UIHostingController(rootView: content)) }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 0.25
        scroll.maximumZoomScale = maxScale
        scroll.bouncesZoom = true
        scroll.showsHorizontalScrollIndicator = true
        scroll.showsVerticalScrollIndicator = true
        let host = context.coordinator.host
        host.view.backgroundColor = .clear
        scroll.addSubview(host.view)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.reset(_:)))
        tap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(tap)
        context.coordinator.layout(scroll)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.host.rootView = content
        if scroll.zoomScale == 1 { context.coordinator.layout(scroll) }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        let host: UIHostingController<Content>
        init(host: UIHostingController<Content>) { self.host = host }

        func layout(_ scroll: UIScrollView) {
            let size = host.sizeThatFits(in: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
            host.view.frame = CGRect(origin: .zero, size: size)
            scroll.contentSize = size
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { host.view }

        @objc func reset(_ tap: UITapGestureRecognizer) {
            guard let scroll = tap.view as? UIScrollView else { return }
            scroll.setZoomScale(scroll.zoomScale == 1 ? min(2, scroll.maximumZoomScale) : 1, animated: true)
        }
    }
}

// MARK: - Code

struct CodeBlock: View {
    let language: String
    let code: String
    var style: MarkdownStyle?
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        let s = style ?? .standard(palette)
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language).font(.caption2.monospaced()).foregroundStyle(s.faint)
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
                .foregroundStyle(s.soft)
                .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 10).padding(.top, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced)).foregroundStyle(s.codeInk)
                    .padding(10).fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(s.codeFill, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(s.line))
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
