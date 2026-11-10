import XCTest

/// Overlay unchanged on base and head. Assertions cover fixture state, not either
/// revision's wording; the parent's copy tests enforce the new text (#2473).
@MainActor
final class QuietReconnectEvidenceTests: XCTestCase {
    func testQuietReconnectEvidence() {
        for count in [0, 1, 3] {
            let app = XCUIApplication()
            app.launchArguments = [
                "-uiTestQuietReconnectEvidence", "-quietReconnectCount", String(count),
                "-splash", "NO", "-appLock", "NO", "-theme", "light", "-expertMode", "NO",
                "-simpleChoices", "{}", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            ]
            app.launchEnvironment["TZ"] = "UTC"
            app.launch()
            let banner = app.descendants(matching: .any)["quietReconnect.banner"].firstMatch
            XCTAssertTrue(banner.waitForExistence(timeout: 15), "Real ConnectionBanner must be visible")
            let saved = app.descendants(matching: .any)["chat.savedCopy"].firstMatch
            XCTAssertTrue(saved.waitForExistence(timeout: 10), "Real ChatView must open the seeded saved transcript")
            XCTAssertTrue(app.staticTexts["Check the tests and review the release notes."].exists)
            let offline = app.descendants(matching: .any)["chat.offlineNote"].firstMatch
            XCTAssertTrue(offline.waitForExistence(timeout: 5), "Real Composer must explain offline sending")
            XCTAssertFalse(saved.label.isEmpty)
            XCTAssertFalse(offline.label.isEmpty)
            // A timestamp must remain visible on both revisions, even when surrounding copy changes.
            XCTAssertNotNil(saved.label.range(of: "[0-9]", options: .regularExpression))
            if count > 0 {
                let labels = banner.descendants(matching: .staticText).allElementsBoundByIndex.map(\.label).joined(separator: " ")
                XCTAssertTrue(labels.contains(String(count)), "Banner must describe the actual in-memory outbox count")
            }
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "quiet-reconnect-\(count)-saved-composer"
            shot.lifetime = .keepAlways
            add(shot)
            app.terminate()
        }
    }
    /// Candidate-only assertions; the comparison method above also runs unchanged on base.
    func testQuietReconnectCopy() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestQuietReconnectEvidence", "-quietReconnectCount", "1",
                               "-splash", "NO", "-appLock", "NO", "-theme", "light",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Reconnecting to Gomi..."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["1 prompt will send when reconnected."].exists)
        let note = app.descendants(matching: .any)["chat.offlineNote"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertEqual(note.label, "Gomi is reconnecting.\nYour draft will be saved here and sent when reconnected")
        XCTAssertTrue(app.descendants(matching: .any)["chat.savedCopy"].firstMatch.label.hasPrefix("Updated last on "))
    }

}
