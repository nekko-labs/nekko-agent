import Foundation
import XCTest
@testable import NekkoProtocol

/// The composer toolbar's edit functions and typing rules (MD-3).
final class MarkdownEditingTests: XCTestCase {
    /// `text` with `‸` marking the caret (or two `‸` marking a selection) → (text, selection).
    private func draft(_ marked: String) -> (String, NSRange) {
        let s = marked as NSString
        let first = s.range(of: "‸")
        let rest = s.replacingCharacters(in: first, with: "") as NSString
        let second = rest.range(of: "‸", options: [], range: NSRange(location: first.location, length: rest.length - first.location))
        if second.location == NSNotFound { return (rest as String, NSRange(location: first.location, length: 0)) }
        return (rest.replacingCharacters(in: second, with: ""), NSRange(location: first.location, length: second.location - first.location))
    }

    /// The edit's text with its selection marked the same way.
    private func shown(_ e: MarkdownEdit) -> String {
        let s = e.text as NSString
        if e.length == 0 { return s.replacingCharacters(in: NSRange(location: e.location, length: 0), with: "‸") }
        let withEnd = s.replacingCharacters(in: NSRange(location: e.location + e.length, length: 0), with: "‸") as NSString
        return withEnd.replacingCharacters(in: NSRange(location: e.location, length: 0), with: "‸")
    }

    private func apply(_ action: MarkdownAction, _ marked: String) -> String {
        let (t, sel) = draft(marked)
        return shown(MarkdownEditing.apply(action, to: t, selection: sel))
    }

    private func active(_ action: MarkdownAction, _ marked: String) -> Bool {
        let (t, sel) = draft(marked)
        return MarkdownEditing.isActive(action, in: t, selection: sel)
    }

    // MARK: Inline styles

    func testTogglesEachInlineStyle() {
        XCTAssertEqual(apply(.bold, "say ‸hello‸ now"), "say **‸hello‸** now")
        XCTAssertEqual(apply(.bold, "say **‸hello‸** now"), "say ‸hello‸ now")
        XCTAssertEqual(apply(.italic, "‸word‸"), "*‸word‸*")
        XCTAssertEqual(apply(.italic, "*‸word‸*"), "‸word‸")
        XCTAssertEqual(apply(.strike, "‸old‸"), "~~‸old‸~~")
        XCTAssertEqual(apply(.code, "run ‸ls‸"), "run `‸ls‸`")
        XCTAssertEqual(apply(.code, "run `l‸s`"), "run l‸s")
        // Nothing selected: the marks go in with the caret between them, and come out again.
        XCTAssertEqual(apply(.bold, "a ‸"), "a **‸**")
        XCTAssertEqual(apply(.bold, "a **‸**"), "a ‸")
        // At the end of bold text the button steps out of it, so typing goes on plain.
        XCTAssertEqual(apply(.bold, "a **b‸** c"), "a **b**‸ c")
        XCTAssertEqual(apply(.italic, "*it‸*"), "*it*‸")
    }

    func testPressedStateFollowsTheSelection() {
        XCTAssertTrue(active(.bold, "**a ‸b‸ c**"))
        XCTAssertFalse(active(.bold, "a ‸b‸ c"))
        // A single * is not mistaken for the inside of a **.
        XCTAssertFalse(active(.italic, "**‸bold‸**"))
        XCTAssertTrue(active(.italic, "*‸it‸*"))
        XCTAssertTrue(active(.link, "[‸docs‸](https://x.dev)"))
        XCTAssertTrue(active(.bullet, "- a\n- ‸b"))
        XCTAssertFalse(active(.bullet, "- [ ] ‸task"))
        XCTAssertTrue(active(.task, "- [ ] ‸task"))
        XCTAssertTrue(active(.fence, "```\n‸code‸\n```"))
    }

    func testLinks() {
        XCTAssertEqual(apply(.link, "see ‸docs‸ here"), "see [docs](‸url‸) here")
        XCTAssertEqual(apply(.link, "see ‸"), "see [‸text‸](url)")
        XCTAssertEqual(apply(.link, "see [‸docs‸](https://x.dev) here"), "see ‸docs‸ here")
    }

    // MARK: Block styles

    func testBlockTogglesOnSeveralLines() {
        XCTAssertEqual(apply(.bullet, "‸one\ntwo‸"), "- ‸one\n- two‸")
        XCTAssertEqual(apply(.bullet, "- ‸one\n- two‸"), "‸one\ntwo‸")
        XCTAssertEqual(apply(.ordered, "‸one\ntwo\nthree‸"), "1. ‸one\n2. two\n3. three‸")
        XCTAssertEqual(apply(.task, "- ‸one"), "- [ ] ‸one")
        XCTAssertEqual(apply(.quote, "a\n‸b‸\nc"), "a\n> ‸b‸\nc")
        XCTAssertEqual(apply(.heading, "‸Title"), "## ‸Title")
        XCTAssertEqual(apply(.heading, "## ‸Title"), "‸Title")
        // Switching style replaces the old marker and keeps the indent.
        XCTAssertEqual(apply(.bullet, "  1. ‸one"), "  - ‸one")
    }

    func testCodeBlockGoesOnLinesOfItsOwn() {
        XCTAssertEqual(apply(.fence, "‸let x = 1‸"), "```\n‸let x = 1‸\n```")
        XCTAssertEqual(apply(.fence, "say ‸x‸ now"), "say \n```\n‸x‸\n```\n now")
        XCTAssertEqual(apply(.fence, "```\n‸x‸\n```"), "‸x‸")
    }

    // MARK: Lists while typing

    func testReturnContinuesAList() {
        func ret(_ marked: String) -> String? {
            let (t, sel) = draft(marked)
            return MarkdownEditing.newline(in: t, selection: sel).map(shown)
        }
        XCTAssertEqual(ret("- one‸"), "- one\n- ‸")
        XCTAssertEqual(ret("  * nested‸"), "  * nested\n  * ‸")
        XCTAssertEqual(ret("1. one‸"), "1. one\n2. ‸")
        XCTAssertEqual(ret("9) nine‸"), "9) nine\n10) ‸")
        XCTAssertEqual(ret("- [x] done‸"), "- [x] done\n- [ ] ‸")
        XCTAssertEqual(ret("> quote‸"), "> quote\n> ‸")
        // In the middle of an item the rest moves to the new item.
        XCTAssertEqual(ret("- one‸ two"), "- one\n- ‸ two")
        // Inserting in the middle of a numbered list renumbers what follows.
        XCTAssertEqual(ret("1. a‸\n2. b\n3. c"), "1. a\n2. ‸\n3. b\n4. c")
        // Plain text: an ordinary newline.
        XCTAssertNil(ret("plain‸"))
        XCTAssertNil(ret("‸- before the marker"))
    }

    func testReturnOnAnEmptyItemEndsTheList() {
        let (t, sel) = draft("- one\n- ‸")
        XCTAssertEqual(MarkdownEditing.newline(in: t, selection: sel).map(shown), "- one\n‸")
        let (t2, sel2) = draft("1. a\n2. ‸\n3. c")
        XCTAssertEqual(MarkdownEditing.newline(in: t2, selection: sel2).map(shown), "1. a\n‸\n3. c", "a top-level list after the gap keeps its number")
    }

    func testIndentAndOutdent() {
        XCTAssertEqual(apply(.indent, "- a\n- ‸b"), "- a\n  - ‸b")
        XCTAssertEqual(apply(.outdent, "- a\n  - ‸b"), "- a\n- ‸b")
        // Under a numbered item the step is three spaces, and the nested list counts from 1.
        XCTAssertEqual(apply(.indent, "1. a\n2. ‸b\n3. c"), "1. a\n   1. ‸b\n2. c")
        XCTAssertEqual(apply(.outdent, "1. a\n   1. ‸b\n2. c"), "1. a\n2. ‸b\n3. c")
        // Several lines at once.
        XCTAssertEqual(apply(.indent, "‸- a\n- b‸"), "  ‸- a\n  - b‸")
        // Outdent at the left edge does nothing.
        XCTAssertEqual(apply(.outdent, "- ‸a"), "- ‸a")
    }

    func testRenumberKeepsATopLevelStart() {
        let e = MarkdownEditing.renumbered(MarkdownEdit(text: "3. a\n7. b\n\npara\n5. c", location: 0))
        XCTAssertEqual(e.text, "3. a\n4. b\n\npara\n5. c")
    }

    // MARK: Tables

    func testInsertsATableSkeleton() {
        XCTAssertEqual(apply(.table, "‸"), "| ‸ |  |\n| --- | --- |\n|  |  |")
        XCTAssertEqual(apply(.table, "Intro‸"), "Intro\n\n| ‸ |  |\n| --- | --- |\n|  |  |")
    }

    func testAddsRowsAndColumnsInsideATable() {
        let (t, sel) = draft("| A | B |\n| --- | --- |\n| 1 | 2‸ |\nafter")
        XCTAssertNotNil(MarkdownEditing.tableLines(t, at: sel.location))
        let row = MarkdownEditing.addRow(t, selection: sel)
        XCTAssertEqual(row.map(shown), "| A | B |\n| --- | --- |\n| 1 | 2 |\n| ‸ |  |\nafter")
        let col = MarkdownEditing.addColumn(t, selection: sel)
        XCTAssertEqual(col.map(shown), "| A | B | ‸ |\n| --- | --- | --- |\n| 1 | 2 |  |\nafter")
        // From the header, a row goes under the divider.
        let (h, hs) = draft("| A‸ | B |\n| --- | --- |")
        XCTAssertEqual(MarkdownEditing.addRow(h, selection: hs).map(shown), "| A | B |\n| --- | --- |\n| ‸ |  |")
        // Outside a table there is nothing to add to.
        XCTAssertNil(MarkdownEditing.addRow("plain", selection: NSRange(location: 2, length: 0)))
        XCTAssertNil(MarkdownEditing.tableLines("a | b", at: 1))
    }

    func testTabMovesThroughTheCells() {
        func tab(_ marked: String) -> String? {
            let (t, sel) = draft(marked)
            return MarkdownEditing.nextCell(t, selection: sel).map(shown)
        }
        XCTAssertEqual(tab("| Name‸ |  |\n| --- | --- |\n|  |  |"), "| Name | ‸ |\n| --- | --- |\n|  |  |")
        // From the header's last cell to the first body cell, past the divider.
        XCTAssertEqual(tab("| Name | Status‸ |\n| --- | --- |\n|  |  |"), "| Name | Status |\n| --- | --- |\n| ‸ |  |")
        // From the last cell, a new row.
        XCTAssertEqual(tab("| A | B |\n| --- | --- |\n| 1 | 2‸ |"), "| A | B |\n| --- | --- |\n| 1 | 2 |\n| ‸ |  |")
        // An escaped pipe is not a cell edge.
        XCTAssertEqual(tab("| a‸ \\| b | c |\n| --- | --- |"), "| a \\| b | ‸c |\n| --- | --- |")
        XCTAssertNil(tab("not‸ a table"))
    }

    /// A selection past the end of the text (the toolbar a moment behind a send) never traps.
    func testAStaleSelectionIsClamped() {
        let past = NSRange(location: 40, length: 3)
        for action in MarkdownAction.allCases {
            _ = MarkdownEditing.isActive(action, in: "- a", selection: past)
            _ = MarkdownEditing.apply(action, to: "", selection: past)
        }
        XCTAssertNil(MarkdownEditing.newline(in: "", selection: past))
        XCTAssertNil(MarkdownEditing.tableLines("", at: 9))
        XCTAssertEqual(MarkdownEditing.clamp(past, in: "abc"), NSRange(location: 3, length: 0))
    }

    /// What the toolbar types parses back as the structure it means.
    func testToolbarOutputParses() {
        var e = MarkdownEditing.apply(.bullet, to: "", selection: NSRange(location: 0, length: 0))
        e.text += "one"
        e = MarkdownEditing.newline(in: e.text, selection: NSRange(location: (e.text as NSString).length, length: 0))!
        e = MarkdownEditing.apply(.indent, to: e.text, selection: e.range)
        e.text += "nested"
        XCTAssertEqual(MarkdownParser.parse(e.text), [.list(MarkdownList(ordered: false, items: [
            MarkdownListItem("one", children: [MarkdownList(ordered: false, items: [MarkdownListItem("nested")])]),
        ]))])
        let table = MarkdownEditing.apply(.table, to: "", selection: NSRange(location: 0, length: 0))
        guard case .table(let t)? = MarkdownParser.parse(table.text).first else { return XCTFail("a table") }
        XCTAssertEqual(t.header.count, 2)
        XCTAssertEqual(t.rows.count, 1)
    }

    // MARK: Live styling

    func testHighlightSpans() {
        let spans = MarkdownHighlight.spans("## Title\n- **bold** and `code`\n```\n**not bold**\n```")
        XCTAssertTrue(spans.contains(MarkdownSpan(.heading(2), NSRange(location: 0, length: 8))))
        XCTAssertTrue(spans.contains(MarkdownSpan(.marker, NSRange(location: 9, length: 1))))
        XCTAssertTrue(spans.contains(MarkdownSpan(.bold, NSRange(location: 11, length: 8))))
        XCTAssertTrue(spans.contains(MarkdownSpan(.syntax, NSRange(location: 11, length: 2))))
        XCTAssertTrue(spans.contains(MarkdownSpan(.code, NSRange(location: 24, length: 6))))
        XCTAssertTrue(spans.contains { $0.kind == .fence })
        // Inside the fence nothing is bold.
        XCTAssertEqual(spans.filter { $0.kind == .bold }.count, 1)
        XCTAssertEqual(MarkdownHighlight.spans("*it* and **b**").filter { $0.kind == .italic }.map(\.range), [NSRange(location: 0, length: 4)])
    }
}
