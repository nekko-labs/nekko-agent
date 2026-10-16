import XCTest
@testable import NekkoNative

final class KeychainStoreTests: XCTestCase {
    func testRoundTripsOverwritesAndDeletes() {
        let s = KeychainStore(service: "com.nekko.native.ios.tests.\(UUID().uuidString)")
        defer { s.wipe() }
        XCTAssertNil(s.get("k"))
        s.set("k", "one")
        XCTAssertEqual(s.get("k"), "one")
        s.set("k", "two")
        XCTAssertEqual(s.get("k"), "two")
        s.set("k", nil)
        XCTAssertNil(s.get("k"))
        s.set("a", "1")
        s.set("b", "2")
        s.wipe()
        XCTAssertNil(s.get("a"))
        XCTAssertNil(s.get("b"))
    }
}

final class MarkdownTests: XCTestCase {
    func testParsesTheBlocksAgentRepliesUse() {
        let md = """
        # Plan
        Some **bold** text
        continued.

        - one
          - nested
        - [x] done
        2. second

        ```swift
        let x = 1
        ```
        > quoted
        ---
        """
        let p = MarkdownText.parse(md)
        XCTAssertEqual(p, [
            .heading(1, "Plan"),
            .paragraph("Some **bold** text\ncontinued."),
            .bullet(0, "•", "one"),
            .bullet(1, "•", "nested"),
            .bullet(0, "☑", "done"),
            .bullet(0, "2.", "second"),
            .code("swift", "let x = 1"),
            .quote("quoted"),
            .rule,
        ])
    }

    func testAnUnclosedFenceStillShowsItsCode() {
        XCTAssertEqual(MarkdownText.parse("```\nstreaming…"), [.code("", "streaming…")])
    }
}

final class PaletteTests: XCTestCase {
    func testPicksReadableInkOnTheAccent() {
        XCTAssertGreaterThan(Palette.luminance(0xFFFFFF), 0.99)
        XCTAssertLessThan(Palette.luminance(0x6D5EFC), 0.45)
    }
}
