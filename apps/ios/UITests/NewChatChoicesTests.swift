import XCTest

/// No paired computer, network or user data: the real New chat with a seeded draft.
final class NewChatChoicesTests: XCTestCase {
    func testConcreteChoicesAndIndependentRecommendations() {
        let app = launch()
        let effort = app.buttons["newChat.effort"]
        XCTAssertTrue(effort.waitForExistence(timeout: 10))
        XCTAssertTrue(effort.label.contains("Medium"))
        attach(app, "iphone-new-chat-after")
        effort.tap()
        XCTAssertFalse(app.buttons["Computer default"].exists)
        XCTAssertTrue(app.buttons["Medium (Recommended)"].waitForExistence(timeout: 3))
        attach(app, "iphone-effort-after")
        option("Low", in: app).tap()
        XCTAssertTrue(effort.label.contains("Low"))
        effort.tap()
        XCTAssertTrue(app.buttons["Medium (Recommended)"].exists, "Saving Low must not move Recommended")
        option("Low", in: app).tap()
        app.buttons["newChat.tools"].tap()
        XCTAssertFalse(app.buttons["Computer default"].exists)
        attach(app, "iphone-tools-after")
        option("YOLO (never ask)", in: app).tap()
        XCTAssertTrue(app.buttons["newChat.tools"].label.contains("YOLO"))
        app.buttons["newChat.tools"].tap()
        XCTAssertTrue(app.buttons["Guardrails (ask for risky tools) (Recommended)"].exists)
        option("YOLO (never ask)", in: app).tap()
    }

    func testMascotLaughRestartsAndReturnsToIdle() { checkLaugh(reduced: false) }
    func testReducedMotionStillShowsLaugh() { checkLaugh(reduced: true) }

    private func checkLaugh(reduced: Bool) {
        let app = launch(reduced ? ["-uiTestReduceMotion"] : [])
        let cat = app.buttons["newChat.mascot"]
        XCTAssertTrue(cat.waitForExistence(timeout: 10))
        cat.tap()
        XCTAssertEqual(cat.value as? String, "Laughing")
        cat.tap()
        XCTAssertEqual(cat.value as? String, "Laughing")
        attach(app, reduced ? "iphone-laugh-reduced-motion" : "iphone-laugh")
        let idle = NSPredicate(format: "value == %@", "Idle")
        expectation(for: idle, evaluatedWith: cat)
        waitForExpectations(timeout: 4)
    }

    private func option(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND NOT identifier BEGINSWITH %@", title, "newChat.")).firstMatch
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestNewChat", "-expertMode", "YES"] + extra
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
