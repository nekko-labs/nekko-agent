import Foundation
import XCTest
@testable import NekkoProtocol

/// Mermaid on the phone (MM-1, MM-2): fence detection, the streaming rule, the size cap and the cache key.
final class MermaidRulesTests: XCTestCase {
    func testDetectsMermaidFencesAndFiles() {
        XCTAssertTrue(MermaidRules.isMermaid(language: "mermaid"))
        XCTAssertTrue(MermaidRules.isMermaid(language: "Mermaid"))
        XCTAssertFalse(MermaidRules.isMermaid(language: "swift"))
        XCTAssertFalse(MermaidRules.isMermaid(language: ""))
        XCTAssertTrue(MermaidRules.isMermaidFile("flow.MMD"))
        XCTAssertTrue(MermaidRules.isMermaidFile("docs/arch.mermaid"))
        XCTAssertFalse(MermaidRules.isMermaidFile("notes.md"))
        // The parser hands the fence's language and whether it has closed.
        guard case .code(let lang, let body, let closed)? = MarkdownParser.parse("```mermaid\ngraph TD\nA-->B\n```").first else {
            return XCTFail("a fence")
        }
        XCTAssertTrue(MermaidRules.isMermaid(language: lang))
        XCTAssertEqual(body, "graph TD\nA-->B")
        XCTAssertTrue(closed)
    }

    /// While a reply streams, the fence is drawn only once it closes, never per token.
    func testNoDrawingBeforeTheFenceCloses() {
        let reply = "Here:\n```mermaid\ngraph TD\nA-->B\n```\nDone."
        var draws = 0
        var prefix = ""
        for ch in reply {
            prefix.append(ch)
            for case .code(let lang, let body, let closed) in MarkdownParser.blocks(prefix) where MermaidRules.isMermaid(language: lang) {
                if MermaidRules.decide(source: body, closed: closed) == .draw { draws += 1 }
                else { XCTAssertEqual(MermaidRules.decide(source: body, closed: closed), .waitForFence) }
            }
        }
        // Drawable from the closing fence to the end: ``` closes it, then "\nDone." follows (7 more characters).
        XCTAssertEqual(draws, 7, "drawable only after the fence closed")
        XCTAssertEqual(MermaidRules.decide(source: "graph TD", closed: false), .waitForFence)
    }

    func testTheSizeCap() {
        let big = "graph TD\n" + String(repeating: "A-->B\n", count: 10_000)
        XCTAssertGreaterThan(big.utf16.count, MermaidRules.maxSource)
        XCTAssertEqual(MermaidRules.decide(source: big, closed: true), .tooLarge)
        XCTAssertEqual(MermaidRules.decide(source: "graph TD\nA-->B", closed: true), .draw)
    }

    func testTheCacheKeySeparatesSourceThemeAndWidth() {
        let k = MermaidRules.cacheKey(source: "graph TD", dark: false, width: 320, version: "12.1.0")
        XCTAssertEqual(k.count, 64)
        XCTAssertEqual(k, MermaidRules.cacheKey(source: "graph TD", dark: false, width: 320, version: "12.1.0"))
        XCTAssertNotEqual(k, MermaidRules.cacheKey(source: "graph LR", dark: false, width: 320, version: "12.1.0"))
        XCTAssertNotEqual(k, MermaidRules.cacheKey(source: "graph TD", dark: true, width: 320, version: "12.1.0"))
        XCTAssertNotEqual(k, MermaidRules.cacheKey(source: "graph TD", dark: false, width: 360, version: "12.1.0"))
        XCTAssertNotEqual(k, MermaidRules.cacheKey(source: "graph TD", dark: false, width: 320, version: "12.2.0"))
        // Widths round down to steps, so a few points of difference reuse the drawing.
        XCTAssertEqual(MermaidRules.drawWidth(358), 320)
        XCTAssertEqual(MermaidRules.drawWidth(361), 360)
        XCTAssertEqual(MermaidRules.drawWidth(10), MermaidRules.widthStep)
    }

    func testKindForVoiceOver() {
        XCTAssertEqual(MermaidRules.kind("graph TD\nA-->B"), "flowchart")
        XCTAssertEqual(MermaidRules.kind("%% a comment\nsequenceDiagram\nA->>B: hi"), "sequence diagram")
        XCTAssertEqual(MermaidRules.kind("pie title Pets"), "pie chart")
        XCTAssertEqual(MermaidRules.kind("nonsense"), "diagram")
    }
}
