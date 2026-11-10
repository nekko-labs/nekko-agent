import XCTest

/// Matched capture on unchanged base and head, with strict interaction checks on head.
@MainActor
final class QuietTranscriptTests: XCTestCase {
    private var baseline: Bool { ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1" }

    func testQuietTranscriptAndKeyboard() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReplyVoices", "-uiTestQuietContext", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-theme", "computer", "-expertMode", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.staticTexts["The signup test has the same fixed timer."].waitForExistence(timeout: 3) || app.scrollViews.firstMatch.waitForExistence(timeout: 10))
        attach(app, "quiet-transcript-default")
        if !baseline {
            let context = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Conversation summary")).firstMatch
            let progress = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Progress note")).firstMatch
            XCTAssertTrue(context.exists)
            XCTAssertTrue(progress.exists)
            XCTAssertTrue(app.staticTexts["Please keep the new prompt visible."].exists)
            XCTAssertFalse(app.staticTexts["The long workspace context stays available on demand."].exists)
            XCTAssertFalse(app.staticTexts["I'll read the test and the page it waits on first."].exists)
            context.tap()
            XCTAssertTrue(app.staticTexts["The long workspace context stays available on demand."].waitForExistence(timeout: 3))
            attach(app, "quiet-context-expanded")
            context.tap()
            progress.tap()
            XCTAssertTrue(app.staticTexts["I'll read the test and the page it waits on first."].waitForExistence(timeout: 3))
            attach(app, "quiet-progress-expanded")
            progress.tap()
        }
        app.terminate()
        app.launchArguments = ["-uiTestChatRefresh", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-theme", "computer", "-expertMode", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.staticTexts["You are at the latest message."].waitForExistence(timeout: 15))
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        field.typeText("Keep this unsent draft")
        let draft = field.value as? String
        XCTAssertTrue(draft?.contains("Keep this unsent draft") == true)
        attach(app, "active-chat-keyboard-open")
        if !baseline {
            let dismiss = app.buttons["composer.hideKeyboard"]
            XCTAssertTrue(dismiss.waitForExistence(timeout: 3))
            XCTAssertTrue(dismiss.isHittable)
            XCTAssertGreaterThanOrEqual(dismiss.frame.width, 44 - 0.001)
            XCTAssertGreaterThanOrEqual(dismiss.frame.height, 44 - 0.001)
            dismiss.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
            XCTAssertEqual(field.value as? String, draft)
            attach(app, "active-chat-keyboard-dismissed")
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
