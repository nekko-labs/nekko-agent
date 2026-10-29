import NekkoProtocol
import SwiftUI
import UIKit

/// The message box (MD-3, MD-4): Markdown source with light live styling, the
/// formatting toolbar inside the card above the text (not a keyboard accessory:
/// on iOS 26 that floated over the send button), list continuation on Return,
/// and the paste choice. What is sent is exactly what was typed.
struct MarkdownComposerField: View {
    @Binding var text: String
    @Binding var focused: Bool
    var placeholder: String
    var identifier = "chat.message"
    /// Paste with only an image on the clipboard: it goes to the attachments, as before.
    var onPasteImages: () -> Void = {}
    /// Draws its own card; false when it sits in a box that holds its buttons too (the chat's composer).
    var boxed = true
    @State private var editor = MarkdownEditorState()
    /// The *Aa* toggle, remembered.
    @AppStorage("composerToolbar") private var toolbarShown = true
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let offer = editor.pasteOffer {
                Button { editor.useFormatting(offer) } label: {
                    Text("Pasted as text · **Use formatting**").font(.caption)
                        .padding(.horizontal, 10).frame(minHeight: 32)
                        .background(palette.accent.opacity(0.14), in: Capsule())
                        .foregroundStyle(palette.ink)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pasted as text. Use formatting")
                .accessibilityIdentifier("composer.useFormatting")
                .task(id: offer.id) {
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    if editor.pasteOffer?.id == offer.id { editor.pasteOffer = nil }
                }
            }
            if focused {
                MarkdownToolbar(editor: editor, text: text, shown: $toolbarShown)
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(placeholder).foregroundStyle(palette.inkFaint).allowsHitTesting(false).accessibilityHidden(true)
                }
                MarkdownEditor(text: $text, focused: $focused, editor: editor, placeholder: placeholder,
                               identifier: identifier, onPasteImages: onPasteImages)
            }
        }
        .padding(.horizontal, boxed ? 12 : 0).padding(.vertical, boxed ? 8 : 0)
        .background(boxed ? palette.surface : .clear, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(boxed ? palette.line : .clear))
    }
}

/// What the toolbar and the text view share: the selection, the text view to edit, a paste to offer formatting for.
@Observable
final class MarkdownEditorState {
    struct PasteOffer: Equatable {
        let id = UUID()
        /// Where the plain text went, and what it was.
        let range: NSRange
        let plain: String
        let markdown: String
    }

    var selection = NSRange(location: 0, length: 0)
    var pasteOffer: PasteOffer?
    @ObservationIgnored weak var textView: MarkdownTextView?

    func perform(_ action: MarkdownAction) {
        guard let tv = textView else { return }
        tv.apply(MarkdownEditing.apply(action, to: tv.text, selection: tv.selectedRange))
    }

    func addRow() {
        guard let tv = textView, let e = MarkdownEditing.addRow(tv.text, selection: tv.selectedRange) else { return }
        tv.apply(e)
    }

    func addColumn() {
        guard let tv = textView, let e = MarkdownEditing.addColumn(tv.text, selection: tv.selectedRange) else { return }
        tv.apply(e)
    }

    /// The chip: swap the pasted plain text for its Markdown, as one undo step.
    func useFormatting(_ offer: PasteOffer) {
        pasteOffer = nil
        guard let tv = textView else { return }
        let s = tv.text as NSString
        guard NSMaxRange(offer.range) <= s.length, s.substring(with: offer.range) == offer.plain else { return }
        let out = s.replacingCharacters(in: offer.range, with: offer.markdown)
        tv.apply(MarkdownEdit(text: out, location: offer.range.location + (offer.markdown as NSString).length))
    }
}

// MARK: - Toolbar

struct MarkdownToolbar: View {
    let editor: MarkdownEditorState
    let text: String
    @Binding var shown: Bool
    @Environment(\.palette) private var palette

    private static let symbols: [MarkdownAction: String] = [
        .bold: "bold", .italic: "italic", .strike: "strikethrough", .code: "chevron.left.forwardslash.chevron.right",
        .link: "link", .heading: "textformat.size", .bullet: "list.bullet", .ordered: "list.number", .task: "checklist",
        .indent: "increase.indent", .outdent: "decrease.indent", .quote: "text.quote", .fence: "curlybraces",
        .table: "tablecells",
    ]

    var body: some View {
        HStack(spacing: 0) {
            Button { shown.toggle() } label: {
                Text("Aa").font(.subheadline.weight(.semibold))
                    .foregroundStyle(shown ? palette.accent : palette.inkSoft)
                    .frame(width: 44, height: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(shown ? "Hide formatting" : "Show formatting")
            .accessibilityIdentifier("composer.formatting")
            if shown {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) {
                        if MarkdownEditing.tableLines(text, at: editor.selection.location) != nil {
                            textButton("+ Row", "Add row", "composer.addRow") { editor.addRow() }
                            textButton("+ Column", "Add column", "composer.addColumn") { editor.addColumn() }
                        }
                        ForEach(MarkdownAction.allCases, id: \.self) { action in
                            button(action)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 40)
    }

    private func button(_ action: MarkdownAction) -> some View {
        let on = action.toggles && MarkdownEditing.isActive(action, in: text, selection: editor.selection)
        return Button { editor.perform(action) } label: {
            Image(systemName: Self.symbols[action] ?? "textformat")
                .font(.body.weight(on ? .semibold : .regular))
                .foregroundStyle(on ? palette.accent : palette.inkSoft)
                .frame(width: 44, height: 40)
                .background(on ? palette.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(action.label)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("composer.\(action.rawValue)")
    }

    private func textButton(_ title: String, _ label: String, _ id: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                .padding(.horizontal, 8).frame(minWidth: 44, minHeight: 40).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}

// MARK: - The text view

struct MarkdownEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let editor: MarkdownEditorState
    var placeholder: String
    var identifier: String
    var maxLines: CGFloat = 6
    var onPasteImages: () -> Void
    @Environment(\.palette) private var palette

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MarkdownTextView {
        let tv = MarkdownTextView()
        tv.delegate = context.coordinator
        tv.backgroundColor = .clear
        tv.font = UIFont.preferredFont(forTextStyle: .body)
        tv.adjustsFontForContentSizeCategory = true
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.isScrollEnabled = false
        tv.allowsEditingTextAttributes = false
        tv.autocapitalizationType = .sentences
        tv.smartDashesType = .no
        tv.smartQuotesType = .no
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.accessibilityIdentifier = identifier
        tv.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Hide keyboard") { [weak tv] _ in
            tv?.resignFirstResponder()
            return true
        }]
        tv.text = text
        editor.textView = tv
        context.coordinator.colors(context.environment.palette)
        context.coordinator.restyle(tv)
        return tv
    }

    func updateUIView(_ tv: MarkdownTextView, context: Context) {
        context.coordinator.parent = self
        editor.textView = tv
        // Accessibility properties only when they change: the composer updates with every
        // streamed token, and resetting them each time kept VoiceOver (and UI tests) busy.
        if tv.accessibilityLabel != placeholder { tv.accessibilityLabel = placeholder }
        tv.onPasteImages = onPasteImages
        tv.onRichPaste = { range, plain, markdown in
            editor.pasteOffer = MarkdownEditorState.PasteOffer(range: range, plain: plain, markdown: markdown)
        }
        if tv.text != text {
            // Set from outside (a draft restored, dictation, Edit on a waiting prompt): not an undoable edit.
            tv.text = text
            context.coordinator.restyle(tv)
        }
        if context.coordinator.colors(palette) { context.coordinator.restyle(tv) }
        if focused && !tv.isFirstResponder {
            DispatchQueue.main.async { _ = tv.becomeFirstResponder() }
        } else if !focused && tv.isFirstResponder {
            DispatchQueue.main.async { _ = tv.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView tv: MarkdownTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 280
        let fit = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = tv.font?.lineHeight ?? 22
        let cap = ceil(line * maxLines)
        let scrolls = fit.height > cap
        if tv.isScrollEnabled != scrolls { tv.isScrollEnabled = scrolls }
        return CGSize(width: width, height: max(ceil(line), min(fit.height, cap)))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MarkdownEditor
        /// The palette's colours, taken while SwiftUI updates the view (the environment isn't readable from delegate calls).
        private var ink = UIColor.label, faint = UIColor.secondaryLabel, accent = UIColor.tintColor
        private var palette: (Color, Color, Color)?
        init(_ parent: MarkdownEditor) { self.parent = parent }

        /// True when the colours changed.
        @discardableResult
        func colors(_ p: Palette) -> Bool {
            if let old = palette, old == (p.ink, p.inkFaint, p.accent) { return false }
            palette = (p.ink, p.inkFaint, p.accent)
            ink = UIColor(p.ink)
            faint = UIColor(p.inkFaint)
            accent = UIColor(p.accent)
            return true
        }

        func textViewDidChange(_ tv: UITextView) {
            if parent.text != tv.text { parent.text = tv.text }
            restyle(tv)
            parent.editor.selection = tv.selectedRange
        }

        func textViewDidChangeSelection(_ tv: UITextView) {
            if parent.editor.selection != tv.selectedRange { parent.editor.selection = tv.selectedRange }
        }

        func textViewDidBeginEditing(_ tv: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ tv: UITextView) { if parent.focused { parent.focused = false } }

        func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText repl: String) -> Bool {
            guard let tv = tv as? MarkdownTextView, !tv.applying, tv.markedTextRange == nil else { return true }
            if repl == "\n", let edit = MarkdownEditing.newline(in: tv.text, selection: range) {
                tv.apply(edit)
                return false
            }
            // Tab (a hardware keyboard, or typed): the next table cell, or one list level deeper.
            if repl == "\t", tv.tab(outdent: false) { return false }
            // Lines added or removed: a numbered list counts again.
            let removed = (tv.text as NSString).substring(with: range)
            if repl.contains("\n") || removed.contains("\n") {
                let out = (tv.text as NSString).replacingCharacters(in: range, with: repl)
                let edit = MarkdownEditing.renumbered(MarkdownEdit(text: out, location: range.location + (repl as NSString).length))
                if edit.text != out {
                    tv.apply(edit)
                    return false
                }
            }
            return true
        }

        func textView(_ tv: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let tv = tv as? MarkdownTextView, UIPasteboard.general.hasStrings else { return nil }
            let ours = UIMenu(options: .displayInline, children: [
                UIAction(title: "Paste as Markdown") { _ in tv.pasteAsMarkdown() },
                UIAction(title: "Paste as plain text") { _ in tv.pasteAsPlainText() },
            ])
            // Ours right after the system's Paste.
            var children = suggestedActions
            let at = children.firstIndex { ($0 as? UIMenu)?.identifier == .standardEdit } .map { $0 + 1 } ?? min(1, children.count)
            children.insert(ours, at: at)
            return UIMenu(children: children)
        }

        /// The source with light styling: bold looks bold with its `**` dimmed, headings larger, markers tinted, code monospaced.
        func restyle(_ tv: UITextView) {
            guard tv.markedTextRange == nil else { return }
            let body = UIFont.preferredFont(forTextStyle: .body)
            let storage = tv.textStorage
            let all = NSRange(location: 0, length: storage.length)
            let selected = tv.selectedRange
            storage.beginEditing()
            storage.setAttributes([.font: body, .foregroundColor: ink], range: all)
            let mono = UIFont.monospacedSystemFont(ofSize: body.pointSize * 0.94, weight: .regular)
            for span in MarkdownHighlight.spans(storage.string) where NSMaxRange(span.range) <= storage.length {
                switch span.kind {
                case .heading(let level):
                    let style: UIFont.TextStyle = level <= 1 ? .title3 : level == 2 ? .headline : .subheadline
                    let f = UIFont.preferredFont(forTextStyle: style)
                    storage.addAttribute(.font, value: f.withTraits(.traitBold), range: span.range)
                case .syntax:
                    storage.addAttribute(.foregroundColor, value: faint, range: span.range)
                case .marker:
                    storage.addAttribute(.foregroundColor, value: accent, range: span.range)
                case .bold:
                    let f = (storage.attribute(.font, at: span.range.location, effectiveRange: nil) as? UIFont) ?? body
                    storage.addAttribute(.font, value: f.withTraits(.traitBold), range: span.range)
                case .italic:
                    let f = (storage.attribute(.font, at: span.range.location, effectiveRange: nil) as? UIFont) ?? body
                    storage.addAttribute(.font, value: f.withTraits(.traitItalic), range: span.range)
                case .strike:
                    storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: span.range)
                case .code, .fence:
                    storage.addAttribute(.font, value: mono, range: span.range)
                case .link:
                    storage.addAttribute(.foregroundColor, value: accent, range: span.range)
                }
            }
            storage.endEditing()
            tv.selectedRange = selected
            tv.typingAttributes = [.font: body, .foregroundColor: ink]
        }
    }
}

final class MarkdownTextView: UITextView {
    var onPasteImages: (() -> Void)?
    var onRichPaste: ((NSRange, String, String) -> Void)?
    /// A programmatic edit is going in: the delegate lets it through untouched.
    private(set) var applying = false

    /// Apply an edit as the smallest replacement (one undo step), then set the selection.
    func apply(_ edit: MarkdownEdit) {
        let old = text as NSString, new = edit.text as NSString
        let shortest = min(old.length, new.length)
        var p = 0
        while p < shortest, old.character(at: p) == new.character(at: p) { p += 1 }
        var s = 0
        while s < shortest - p, old.character(at: old.length - 1 - s) == new.character(at: new.length - 1 - s) { s += 1 }
        let replacement = new.substring(with: NSRange(location: p, length: new.length - p - s))
        if let start = position(from: beginningOfDocument, offset: p),
           let end = position(from: start, offset: old.length - p - s),
           let range = textRange(from: start, to: end) {
            applying = true
            replace(range, withText: replacement)
            applying = false
            delegate?.textViewDidChange?(self)
        }
        selectedRange = NSRange(location: min(edit.location, (text as NSString).length),
                                length: min(edit.length, max(0, (text as NSString).length - edit.location)))
        delegate?.textViewDidChangeSelection?(self)
    }

    private func insert(_ s: String) {
        guard let range = selectedTextRange else { return }
        applying = true
        replace(range, withText: s)
        applying = false
        delegate?.textViewDidChange?(self)
    }

    // MARK: Paste

    /// A normal paste stays plain text; an image alone goes to the attachments.
    /// After rich text, the composer offers its Markdown for a few seconds.
    override func paste(_ sender: Any?) {
        let pb = UIPasteboard.general
        if !pb.hasStrings, pb.hasImages {
            onPasteImages?()
            return
        }
        guard let plain = pb.string else { return super.paste(sender) }
        let start = selectedRange.location
        insert(plain)
        if pb.contains(pasteboardTypes: RichClipboard.types), let md = RichClipboard.markdown(pb), md != plain {
            onRichPaste?(NSRange(location: start, length: (plain as NSString).length), plain, md)
        }
    }

    /// The clipboard's rich text as Markdown (or its plain text when it has none).
    @objc func pasteAsMarkdown() {
        let pb = UIPasteboard.general
        insert(RichClipboard.markdown(pb) ?? pb.string ?? "")
    }

    /// The clipboard's plain text, literally (Markdown characters and all).
    @objc func pasteAsPlainText() {
        insert(UIPasteboard.general.string ?? "")
    }

    // MARK: Hardware keyboard

    override var keyCommands: [UIKeyCommand]? {
        let indent = UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(tabIndent))
        let outdent = UIKeyCommand(input: "\t", modifierFlags: .shift, action: #selector(tabOutdent))
        indent.wantsPriorityOverSystemBehavior = true
        outdent.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [indent, outdent]
    }

    @objc private func tabIndent() { if !tab(outdent: false) { insert("  ") } }
    @objc private func tabOutdent() { _ = tab(outdent: true) }

    /// Tab in a table goes to the next cell; on a list line it nests the item
    /// (Shift-Tab un-nests). False when neither applies.
    @discardableResult
    func tab(outdent: Bool) -> Bool {
        if !outdent, let next = MarkdownEditing.nextCell(text, selection: selectedRange) {
            apply(next)
            return true
        }
        let s = text as NSString
        let line = s.substring(with: s.lineRange(for: NSRange(location: selectedRange.location, length: 0)))
        let isList = MarkdownEditing.isActive(.bullet, in: line, selection: NSRange(location: 0, length: 0))
            || MarkdownEditing.isActive(.ordered, in: line, selection: NSRange(location: 0, length: 0))
            || MarkdownEditing.isActive(.task, in: line, selection: NSRange(location: 0, length: 0))
        guard isList || outdent else { return false }
        apply(MarkdownEditing.indent(text, selection: selectedRange, outdent: outdent))
        return true
    }
}

/// Reading the clipboard's rich text, only ever on an explicit paste.
enum RichClipboard {
    static let types = ["public.html", "public.rtf"]

    static func markdown(_ pb: UIPasteboard) -> String? {
        let plain = pb.string ?? ""
        if let data = pb.data(forPasteboardType: "public.html"),
           let html = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) {
            return RichPaste.markdown(html: html, plain: plain)
        }
        // RTF (Notes, Pages): read as an attributed string (no network, no scripts), described as simple HTML.
        if let data = pb.data(forPasteboardType: "public.rtf"),
           let attributed = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
            return RichPaste.markdown(html: html(attributed), plain: plain)
        }
        return nil
    }

    /// Bold, italic, strikethrough, monospace and links as tags, one `<p>` per line,
    /// and lines in a text list as `<li>` (nested by the list's depth).
    static func html(_ a: NSAttributedString) -> String {
        let s = a.string as NSString
        var out = ""
        var openLists: [String] = []
        var location = 0
        while location < s.length {
            let lineRange = s.lineRange(for: NSRange(location: location, length: 0))
            location = NSMaxRange(lineRange)
            var content = lineRange
            if content.length > 0, s.substring(with: NSRange(location: NSMaxRange(content) - 1, length: 1)) == "\n" { content.length -= 1 }
            let style = content.length > 0 ? a.attribute(.paragraphStyle, at: content.location, effectiveRange: nil) as? NSParagraphStyle : nil
            let lists = style?.textLists ?? []
            while openLists.count > lists.count { out += "</\(openLists.removeLast())>" }
            while openLists.count < lists.count {
                let tag = lists[openLists.count].markerFormat == .decimal ? "ol" : "ul"
                out += "<\(tag)>"
                openLists.append(tag)
            }
            var line = ""
            a.enumerateAttributes(in: content, options: []) { attrs, range, _ in
                var t = escape(s.substring(with: range))
                // The list marker RTF keeps in the text ("\t•\t").
                if !lists.isEmpty && range.location == content.location {
                    t = t.replacingOccurrences(of: #"^\t?[^\t]{0,4}\t"#, with: "", options: .regularExpression)
                }
                if let font = attrs[.font] as? UIFont {
                    let traits = font.fontDescriptor.symbolicTraits
                    if traits.contains(.traitMonoSpace) { t = "<code>\(t)</code>" }
                    if traits.contains(.traitBold) { t = "<b>\(t)</b>" }
                    if traits.contains(.traitItalic) { t = "<i>\(t)</i>" }
                }
                if let strike = attrs[.strikethroughStyle] as? Int, strike != 0 { t = "<s>\(t)</s>" }
                if let link = attrs[.link] as? URL { t = "<a href=\"\(escape(link.absoluteString))\">\(t)</a>" }
                else if let link = attrs[.link] as? String { t = "<a href=\"\(escape(link))\">\(t)</a>" }
                line += t
            }
            out += lists.isEmpty ? "<p>\(line)</p>" : "<li>\(line)</li>"
        }
        while let tag = openLists.popLast() { out += "</\(tag)>" }
        return out
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let d = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(traits)) else { return self }
        return UIFont(descriptor: d, size: pointSize)
    }
}
