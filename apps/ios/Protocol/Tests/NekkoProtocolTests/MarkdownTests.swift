import Foundation
import XCTest
@testable import NekkoProtocol

/// The phone's Markdown parser (MD-1): the blocks agent replies and phone messages use.
final class MarkdownTests: XCTestCase {
    private func item(_ text: String, _ task: MarkdownListItem.Task? = nil, _ children: [MarkdownList] = []) -> MarkdownListItem {
        MarkdownListItem(text, task: task, children: children)
    }

    func testParsesTheBlocksAgentRepliesUse() {
        let md = """
        # Plan
        Some **bold** text
        continued.

        ```swift
        let x = 1
        ```
        > quoted
        > - in a list

        ---
        ## Next ##
        """
        XCTAssertEqual(MarkdownParser.parse(md), [
            .heading(level: 1, text: "Plan"),
            .paragraph("Some **bold** text\ncontinued."),
            .code(language: "swift", body: "let x = 1", closed: true),
            .quote([.paragraph("quoted"), .list(MarkdownList(ordered: false, items: [item("in a list")]))]),
            .rule,
            .heading(level: 2, text: "Next"),
        ])
    }

    func testNestsListsThreeDeep() {
        let md = """
        - one
          - two
            - three
          - two again
        - back to one
        """
        XCTAssertEqual(MarkdownParser.parse(md), [.list(MarkdownList(ordered: false, items: [
            item("one", nil, [MarkdownList(ordered: false, items: [
                item("two", nil, [MarkdownList(ordered: false, items: [item("three")])]),
                item("two again"),
            ])]),
            item("back to one"),
        ]))])
    }

    func testMixesBulletAndNumberedLists() {
        let md = """
        1. First
           - detail
           - more
        2. Second
           1. sub one
           2. sub two
        - a bullet after the numbers
        """
        XCTAssertEqual(MarkdownParser.parse(md), [
            .list(MarkdownList(ordered: true, start: 1, items: [
                item("First", nil, [MarkdownList(ordered: false, items: [item("detail"), item("more")])]),
                item("Second", nil, [MarkdownList(ordered: true, start: 1, items: [item("sub one"), item("sub two")])]),
            ])),
            .list(MarkdownList(ordered: false, items: [item("a bullet after the numbers")])),
        ])
    }

    func testAnOrderedListKeepsItsStartNumber() {
        XCTAssertEqual(MarkdownParser.parse("3) three\n4) four"), [
            .list(MarkdownList(ordered: true, start: 3, items: [item("three"), item("four")])),
        ])
    }

    func testWrappedAndContinuedLinesHangUnderTheirItem() {
        let md = """
        - a long item
          that wraps
          - child
          more for the parent
        - lazy
        continuation

          second paragraph of lazy
        """
        XCTAssertEqual(MarkdownParser.parse(md), [.list(MarkdownList(ordered: false, items: [
            item("a long item\nthat wraps\nmore for the parent", nil, [MarkdownList(ordered: false, items: [item("child")])]),
            item("lazy\ncontinuation\n\nsecond paragraph of lazy"),
        ]))])
    }

    func testABlankLineThenAnUnindentedLineEndsTheList() {
        XCTAssertEqual(MarkdownParser.parse("- a\n\nafter"), [
            .list(MarkdownList(ordered: false, items: [item("a")])),
            .paragraph("after"),
        ])
        // A nested item after a blank line stays nested.
        XCTAssertEqual(MarkdownParser.parse("- a\n\n  - b"), [
            .list(MarkdownList(ordered: false, items: [item("a", nil, [MarkdownList(ordered: false, items: [item("b")])])])),
        ])
    }

    func testTaskItemsBecomeCheckboxes() {
        XCTAssertEqual(MarkdownParser.parse("- [ ] todo\n- [x] done\n- [X] also\n- [ ]\n- [link](u)"), [
            .list(MarkdownList(ordered: false, items: [
                item("todo", .open), item("done", .done), item("also", .done), item("", .open), item("[link](u)"),
            ])),
        ])
    }

    func testNotEveryDashOrNumberIsAList() {
        XCTAssertEqual(MarkdownParser.parse("**bold** start\n-not a list\n2026. A year."), [
            .paragraph("**bold** start\n-not a list\n2026. A year."),
        ])
        XCTAssertEqual(MarkdownParser.parse("* * *"), [.rule])
    }

    func testMarkersChangeByDepth() {
        XCTAssertEqual((0..<4).map { MarkdownParser.marker(ordered: false, depth: $0, number: 1) }, ["•", "◦", "▪", "•"])
        XCTAssertEqual(MarkdownParser.marker(ordered: true, depth: 0, number: 12), "12.")
        XCTAssertEqual(MarkdownParser.marker(ordered: true, depth: 1, number: 2), "b.")
        XCTAssertEqual(MarkdownParser.marker(ordered: true, depth: 1, number: 27), "aa.")
        XCTAssertEqual(MarkdownParser.marker(ordered: true, depth: 2, number: 4), "iv.")
        XCTAssertEqual(MarkdownParser.marker(ordered: true, depth: 2, number: 1994), "mcmxciv.")
    }

    // MARK: Tables

    func testParsesATableWithAlignment() {
        let md = """
        | Name | Status | Count |
        |:-----|:------:|------:|
        | Nekko | **done** | 3 |
        | Relay | open | 12 |
        """
        XCTAssertEqual(MarkdownParser.parse(md), [.table(MarkdownTable(
            header: ["Name", "Status", "Count"],
            alignments: [.leading, .center, .trailing],
            rows: [["Nekko", "**done**", "3"], ["Relay", "open", "12"]]))])
    }

    func testEscapedPipesStayInTheCell() {
        guard case .table(let t)? = MarkdownParser.parse("| a | b |\n|---|---|\n| x \\| y | `z` |").first else { return XCTFail("a table") }
        XCTAssertEqual(t.rows, [["x | y", "`z`"]])
        XCTAssertEqual(t.markdown, "| a | b |\n| --- | --- |\n| x \\| y | `z` |")
    }

    func testRaggedRowsArePaddedToTheHeader() {
        guard case .table(let t)? = MarkdownParser.parse("a | b | c\n--- | --- | ---\n| 1 |\n1 | 2 | 3 | 4").first else { return XCTFail("a table") }
        XCTAssertEqual(t.rows, [["1", "", ""], ["1", "2", "3"]])
    }

    func testATableNeedsAMatchingDivider() {
        XCTAssertEqual(MarkdownParser.parse("a | b\n---"), [.paragraph("a | b"), .rule])
        XCTAssertEqual(MarkdownParser.parse("| a | b |\n|---|"), [.paragraph("| a | b |\n|---|")])
    }

    func testATableEndsAtABlankOrPipelessLine() {
        XCTAssertEqual(MarkdownParser.parse("| a |\n|---|\n| 1 |\nafter"), [
            .table(MarkdownTable(header: ["a"], alignments: [.leading], rows: [["1"]])),
            .paragraph("after"),
        ])
    }

    func testTableCopiesAndAccessibility() {
        let t = MarkdownTable(header: ["Name", "Status"], alignments: [.leading, .center],
                              rows: [["**Nekko**", "done"], ["[Relay](https://x.dev)", "a\tb"]])
        XCTAssertEqual(t.tabSeparated, "Name\tStatus\nNekko\tdone\nRelay\ta b")
        XCTAssertEqual(t.markdown, "| Name | Status |\n| --- | :---: |\n| **Nekko** | done |\n| [Relay](https://x.dev) | a\tb |")
        XCTAssertEqual(t.accessibilityRow(1), "Row 2 of 2: Name, Relay; Status, a\tb")
        XCTAssertFalse(t.isLarge)
        XCTAssertTrue(MarkdownTable(header: Array(repeating: "c", count: 5), alignments: [], rows: []).isLarge)
        XCTAssertTrue(MarkdownTable(header: ["c"], alignments: [], rows: Array(repeating: ["x"], count: 13)).isLarge)
    }

    // MARK: Fences and streaming

    func testAnUnclosedFenceStillShowsItsCode() {
        XCTAssertEqual(MarkdownParser.parse("```\nstreaming…"), [.code(language: "", body: "streaming…", closed: false)])
        XCTAssertEqual(MarkdownParser.parse("~~~mermaid\ngraph TD\n~~~"), [.code(language: "mermaid", body: "graph TD", closed: true)])
        // Blank lines inside a fence are code, and a shorter run doesn't close it.
        XCTAssertEqual(MarkdownParser.parse("````\na\n\n```\nb\n````"), [.code(language: "", body: "a\n\n```\nb", closed: true)])
    }

    func testSegmentsSplitOnlyWhereNothingCarriesAcross() {
        let md = "# A\npara\n\n- x\n\n  - y\n\n```\none\n\ntwo\n```\n\nlast"
        XCTAssertEqual(MarkdownParser.segments(md), ["# A\npara", "- x\n\n  - y", "```\none\n\ntwo\n```", "last"])
    }

    /// The cached, segment-by-segment parse is the same as one pass, so streaming can't change the result.
    func testBlocksMatchAWholeParse() {
        let md = """
        # Report

        Intro with `code` and a [link](https://example.com).

        1. Step one
           - sub
             continued

           - after a blank
        2. Step two

        | a | b |
        |---|:-:|
        | 1 | 2 |

        > quote
        > more

        ```mermaid
        graph TD

        A --> B
        ```

        - [ ] open
        - [x] done
        ---
        tail
        """
        XCTAssertEqual(MarkdownParser.blocks(md), MarkdownParser.parse(md))
        // Every prefix too, as a reply streams in.
        var prefix = ""
        for ch in md {
            prefix.append(ch)
            XCTAssertEqual(MarkdownParser.blocks(prefix), MarkdownParser.parse(prefix), "prefix \(prefix.count)")
        }
    }

    func testPlainText() {
        XCTAssertEqual(MarkdownParser.plainText("**a** `b` ~~c~~ [d](e) ![f](g)"), "a b c d f")
    }
}
