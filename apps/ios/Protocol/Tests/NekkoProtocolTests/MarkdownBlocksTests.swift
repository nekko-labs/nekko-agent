import XCTest
@testable import NekkoProtocol

final class MarkdownBlocksTests: XCTestCase {
    func testTheExistingBlocksStillParse() {
        let blocks = MarkdownBlocks.parse("""
        # Title
        Some text
        more text

        - one
          - [x] done
        2. second
        > quoted
        ---
        ```swift
        let a = 1
        ```
        """)
        XCTAssertEqual(blocks, [
            .heading(1, "Title"), .paragraph("Some text\nmore text"), .bullet(0, "•", "one"), .bullet(1, "☑", "done"),
            .bullet(0, "2.", "second"), .quote("quoted"), .rule, .code("swift", "let a = 1"),
        ])
    }

    func testAPipeTableWithAlignment() {
        let blocks = MarkdownBlocks.parse("""
        Before
        | Name | Count | Note |
        | :--- | ---: | :-: |
        | a | 1 | **bold** |
        | b | 22 | x |
        After
        """)
        XCTAssertEqual(blocks, [
            .paragraph("Before"),
            .table(MarkdownTable(header: ["Name", "Count", "Note"], alignments: [.leading, .trailing, .center],
                                 rows: [["a", "1", "**bold**"], ["b", "22", "x"]])),
            .paragraph("After"),
        ])
    }

    func testOuterPipesAreOptionalAndRaggedRowsArePaddedOrCut() {
        let blocks = MarkdownBlocks.parse("a | b | c\n--- | --- | ---\n| 1 |\n1 | 2 | 3 | 4\n")
        XCTAssertEqual(blocks, [.table(MarkdownTable(header: ["a", "b", "c"], alignments: [.leading, .leading, .leading],
                                                     rows: [["1", "", ""], ["1", "2", "3"]]))])
    }

    func testEscapedPipesStayInTheCell() {
        guard case .table(let t) = MarkdownBlocks.parse("| expr | means |\n|---|---|\n| `a \\| b` | a or b \\|\n").first else {
            return XCTFail("not a table")
        }
        XCTAssertEqual(t.header, ["expr", "means"])
        XCTAssertEqual(t.rows, [["`a | b`", "a or b |"]])
        XCTAssertEqual(MarkdownBlocks.row("a \\* b | c"), ["a \\* b", "c"], "other escapes are left for the inline parser")
    }

    func testATableEndsAtABlankLineOrALineWithoutPipes() {
        let blocks = MarkdownBlocks.parse("| a |\n| --- |\n| 1 |\nplain\n\n| 2 |")
        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[1], .paragraph("plain"))
        XCTAssertEqual(blocks[2], .paragraph("| 2 |"), "a lone row is no table")
    }

    func testNoTableWithoutAMatchingDelimiterRow() {
        XCTAssertEqual(MarkdownBlocks.parse("| a | b |\n| --- |\n"), [.paragraph("| a | b |\n| --- |")])
        XCTAssertEqual(MarkdownBlocks.parse("a | b\nnot a delimiter"), [.paragraph("a | b\nnot a delimiter")])
        XCTAssertEqual(MarkdownBlocks.parse("a\n---"), [.paragraph("a"), .rule])
        XCTAssertNil(MarkdownBlocks.delimiter("| : | --- |"))
        XCTAssertNil(MarkdownBlocks.delimiter("---"), "a single column needs a pipe")
    }

    func testTablesInsideCodeFencesStayCode() {
        let blocks = MarkdownBlocks.parse("```\n| a | b |\n| - | - |\n```")
        XCTAssertEqual(blocks, [.code("", "| a | b |\n| - | - |")])
    }

    func testCellsReadOutForVoiceOver() {
        let t = MarkdownTable(header: ["Name", "Status"], alignments: [.leading, .leading], rows: [["Nekko", ""]])
        XCTAssertEqual(t.accessibilityLabel(row: 0, column: 1), "Column header: Status")
        XCTAssertEqual(t.accessibilityLabel(row: 1, column: 0), "Row 1, Name: Nekko")
        XCTAssertEqual(t.accessibilityLabel(row: 1, column: 1), "Row 1, Status: empty")
    }
}
