import Foundation
import XCTest
@testable import NekkoProtocol

/// The same cases as Android's SharedTextTest, so both apps pre-fill alike.
final class SharedTextTests: XCTestCase {
    func testPlainTextIsKeptTrimmed() {
        XCTAssertEqual(SharedText.from(text: "  Summarise this \n", subject: nil), "Summarise this")
    }

    func testABrowserSharePutsThePageTitleAboveTheLink() {
        XCTAssertEqual(SharedText.from(text: "https://example.com/k24", subject: "Kotlin 2.4 released"),
                       "Kotlin 2.4 released\n\nhttps://example.com/k24")
    }

    func testTheSubjectIsDroppedWhenTheTextAlreadyHasIt() {
        XCTAssertEqual(SharedText.from(text: "Kotlin 2.4 released https://example.com/k24", subject: "Kotlin 2.4 released"),
                       "Kotlin 2.4 released https://example.com/k24")
    }

    func testASubjectAloneStillMakesAPrompt() {
        XCTAssertEqual(SharedText.from(text: nil, subject: "Only a title"), "Only a title")
    }

    func testNothingUsableIsNil() {
        XCTAssertNil(SharedText.from(text: nil, subject: nil))
        XCTAssertNil(SharedText.from(text: "   \n\t ", subject: ""))
    }

    func testWindowsNewlinesAndControlCharactersAreCleaned() {
        XCTAssertEqual(SharedText.from(text: "a\r\nb\tc\u{0000}\u{0007}\u{009F}", subject: nil), "a\nb\tc")
    }

    func testAVeryLongShareIsCutAndSaysSo() throws {
        let out = try XCTUnwrap(SharedText.from(text: String(repeating: "x", count: SharedText.maxCharacters + 500), subject: nil))
        XCTAssertTrue(out.hasSuffix(SharedText.cutNote))
        XCTAssertEqual(out.count - SharedText.cutNote.count, SharedText.maxCharacters)
    }

    func testTheCutNeverSplitsAnEmoji() throws {
        let text = String(repeating: "x", count: SharedText.maxCharacters - 1) + "👩‍💻" + "tail"
        let out = try XCTUnwrap(SharedText.from(text: text, subject: nil))
        let kept = String(out.dropLast(SharedText.cutNote.count))
        XCTAssertEqual(kept.count, SharedText.maxCharacters)
        XCTAssertEqual(kept.last, "👩‍💻")
    }

    func testExactlyTheLimitIsNotCut() {
        let text = String(repeating: "y", count: SharedText.maxCharacters)
        XCTAssertEqual(SharedText.from(text: text, subject: nil), text)
    }
}

final class ShareInboxTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "nekko.share.tests.\(UUID().uuidString)"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testAShareIsTakenOnce() {
        let inbox = ShareInbox(defaults: defaults)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        inbox.offer("hello", now: t0)
        XCTAssertTrue(inbox.hasText)
        XCTAssertEqual(inbox.take(now: t0.addingTimeInterval(5)), "hello")
        XCTAssertFalse(inbox.hasText)
        XCTAssertNil(inbox.take(now: t0.addingTimeInterval(6)))
    }

    func testAStaleShareIsDroppedNotReturned() {
        let inbox = ShareInbox(defaults: defaults)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        inbox.offer("old", now: t0)
        XCTAssertNil(inbox.take(now: t0.addingTimeInterval(ShareInbox.lifetime + 1)))
        XCTAssertFalse(inbox.hasText, "removed even though it was too old to use")
    }

    func testAShareFromTheFutureIsIgnored() {
        // A clock change between the share and opening the app.
        let inbox = ShareInbox(defaults: defaults)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        inbox.offer("skewed", now: t0)
        XCTAssertNil(inbox.take(now: t0.addingTimeInterval(-60)))
    }

    func testANewShareReplacesAnUnusedOne() {
        let inbox = ShareInbox(defaults: defaults)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        inbox.offer("first", now: t0)
        inbox.offer("second", now: t0.addingTimeInterval(1))
        XCTAssertEqual(inbox.take(now: t0.addingTimeInterval(2)), "second")
    }
}
