import XCTest

/// The same journeys and in-memory fixture run on the unchanged base and head.
/// No pairing, network requests, credentials or user-owned application data.
@MainActor
final class TitleComposerEvidenceTests: XCTestCase {
    private var theme = "light"

    func testTitleAndComposerEvidence() {
        for appearance in ["light", "dark"] {
            theme = appearance
            captureTitleAndComposer()
        }
    }

    private func captureTitleAndComposer() {
        var app = launch("-uiTestChatStatus", extra: ["-uiTestLongTitles"])
        XCTAssertTrue(app.buttons["chats.mascot"].waitForExistence(timeout: 10))
        let title = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@", "Fix automatic chat titles and make composer options compact")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5), "The full title stays available to accessibility")
        attach(app, "chat-list-titles")
        app.terminate()

        app = launch("-uiTestNewChat")
        let effort = app.buttons["newChat.effort"]
        XCTAssertTrue(effort.waitForExistence(timeout: 10))
        for id in ["newChat.model", "newChat.effort", "newChat.folder", "newChat.tools"] {
            let control = app.buttons[id]
            XCTAssertTrue(control.exists, id)
            // CGRect subtraction can report a nominal 44 pt as 43.99999999999994.
            // Allow only floating-point roundoff, never a smaller touch target.
            let height = control.frame.height
            XCTAssertGreaterThanOrEqual(height + height.ulp * 16, 44, id)
            XCTAssertTrue(control.isHittable, id)
        }
        attach(app, "new-chat-options")
        effort.tap()
        XCTAssertTrue(app.buttons["Medium (Recommended)"].waitForExistence(timeout: 3))
        attach(app, "new-chat-effort-menu")
        app.buttons["Medium (Recommended)"].tap()
        app.buttons["newChat.folder"].tap()
        XCTAssertTrue(app.buttons["Manage folders"].waitForExistence(timeout: 3))
        attach(app, "new-chat-folder-menu")
        app.terminate()

        app = launch("-uiTestChatRefresh")
        XCTAssertTrue(app.staticTexts["You are at the latest message."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["chat.modelEffort"].exists)
        attach(app, "active-chat-composer")
        app.terminate()
    }

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [fixture, "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-uiTestReset", "YES", "-theme", theme, "-expertMode", "YES",
                               "-AppleLanguages", "(en)"] + extra
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "\(theme)-\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
