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

@MainActor
final class DeepLinkTests: XCTestCase {
    func testPairingAndChatLinksAreRouted() {
        let app = AppModel.shared
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent-pair:?relay=wss%3A%2F%2Frelay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff&pair=ABCD2345")!)
        XCTAssertEqual(app.pendingLink?.relayUrl, "wss://relay.example.com")
        XCTAssertEqual(app.pendingLink?.pair, "ABCD2345")
        app.pendingLink = nil
        app.handle(url: URL(string: "nekko-agent://chat/s_123")!)
        XCTAssertEqual(app.openChat, "s_123")
        XCTAssertNil(app.pendingLink)
        app.openChat = nil
        app.handle(url: URL(string: "nekko-agent-pair:?nothing=here")!)
        XCTAssertNil(app.pendingLink)
    }
}
