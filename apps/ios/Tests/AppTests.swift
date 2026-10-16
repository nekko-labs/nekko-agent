import XCTest
import SwiftUI
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
        XCTAssertEqual(Palette.contrast(0xFFFFFF, 0x000000), 21, accuracy: 0.01)
    }

    /// WCAG AA (4.5:1) for the text colours on the surfaces they sit on, in both themes.
    func testTextColoursMeetAA() {
        // Light: paper, surface, surface2. Dark: paper, surface, surface2.
        let light = [0xFBFBFD, 0xFFFFFF, 0xF2F2F7], dark = [0x0C0C11, 0x16161C, 0x20202A]
        for bg in light {
            for ink in [0x17171D, 0x52525E, 0x6A6A76, 0x5A4AE8, 0xB42318, 0x8F5C0A, 0x1D4ED8, 0x1E7A4A] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        for bg in dark {
            for ink in [0xECEAF3, 0xA3A1B0, 0x8E8E9B, 0x8B7DFF, 0xEF6A5B, 0xE3A446, 0x60A5FA, 0x4CC38A] {
                XCTAssertGreaterThanOrEqual(Palette.contrast(ink, bg), 4.5, String(format: "%06X on %06X", ink, bg))
            }
        }
        // Button labels on the default accents.
        XCTAssertGreaterThanOrEqual(Palette.contrast(0xFFFFFF, 0x5A4AE8), 4.5)
        XCTAssertGreaterThanOrEqual(Palette.contrast(0x0C0C11, 0x8B7DFF), 4.5)
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

final class StatusWidgetTests: XCTestCase {
    func testHeadlineSaysWhatNeedsYouFirst() {
        func s(_ needs: Int, _ running: Int, online: Bool = true, computer: String? = "Mac") -> String {
            StatusSnapshot(computer: computer, online: online, needsYou: needs, running: running, at: .now).headline
        }
        XCTAssertEqual(s(0, 0, computer: nil), "Not paired")
        XCTAssertEqual(s(1, 3), "1 needs you")
        XCTAssertEqual(s(2, 0), "2 need you")
        XCTAssertEqual(s(0, 1), "1 working")
        XCTAssertEqual(s(0, 4), "4 working")
        XCTAssertEqual(s(0, 0), "All quiet")
        XCTAssertEqual(s(0, 0, online: false), "Offline")
    }

    func testSavesCountsOnlyAndReportsRealChanges() throws {
        let suite = "nekko.widget.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(StatusSnapshot.load(defaults), .empty)
        let a = StatusSnapshot(computer: "Mac", online: true, needsYou: 1, running: 0, at: Date(timeIntervalSince1970: 100))
        XCTAssertTrue(a.save(defaults))
        XCTAssertEqual(StatusSnapshot.load(defaults), a)
        // Only the time moved: no widget reload.
        var later = a
        later.at = Date(timeIntervalSince1970: 200)
        XCTAssertFalse(later.save(defaults))
        var answered = later
        answered.needsYou = 0
        XCTAssertTrue(answered.save(defaults))
        // Nothing but counts and the computer's name is stored.
        let raw = try XCTUnwrap(defaults.data(forKey: StatusSnapshot.key))
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any]).keys.sorted()
        XCTAssertEqual(keys, ["at", "computer", "needsYou", "online", "running"])
    }

    @MainActor
    func testRendersTheSmallWidget() throws {
        let snapshot = StatusSnapshot(computer: "Studio Mac", online: true, needsYou: 2, running: 1, at: .now.addingTimeInterval(-120))
        for scheme in [ColorScheme.light, .dark] {
            let view = StatusWidgetView(snapshot: snapshot, family: .systemSmall)
                .padding(16)
                .frame(width: 170, height: 170)
                .background(scheme == .dark ? Color(white: 0.11) : Color(white: 0.96))
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let shot = XCTAttachment(image: image)
            shot.name = "widget-small-\(scheme == .dark ? "dark" : "light")"
            shot.lifetime = .keepAlways
            add(shot)
        }
    }
}
