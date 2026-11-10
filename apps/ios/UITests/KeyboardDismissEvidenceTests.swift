import XCTest

/// The same real-chat fixture and keyboard route on base and fix.
@MainActor
final class KeyboardDismissEvidenceTests: XCTestCase {
    func testOneKeyboardDismissControl() {
        let baseline = ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1"
        let app = XCUIApplication()
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
        let controls = app.buttons.matching(identifier: "composer.hideKeyboard")
        XCTAssertEqual(controls.count, baseline ? 2 : 1, "base reproduces duplicate controls; fix has exactly one")
        attach(app, "chat-keyboard-open")
        if !baseline {
            let dismiss = controls.element(boundBy: 0)
            XCTAssertTrue(dismiss.isHittable)
            XCTAssertGreaterThanOrEqual(dismiss.frame.width, 44 - 0.001)
            XCTAssertGreaterThanOrEqual(dismiss.frame.height, 44 - 0.001)
            dismiss.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
            XCTAssertEqual(field.value as? String, draft)
            XCTAssertEqual(controls.count, 0)
            attach(app, "chat-keyboard-dismissed")
            field.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            XCTAssertEqual(controls.count, 1)
            XCTAssertEqual(field.value as? String, draft)
            attach(app, "chat-keyboard-reopened")
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
