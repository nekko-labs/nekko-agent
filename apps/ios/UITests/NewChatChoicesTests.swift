import XCTest

/// No paired computer, network or user data: the real New chat with a seeded draft.
@MainActor
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
        app.buttons["tools.yolo"].tap()
        // Turning YOLO on warns first (decision 0054).
        XCTAssertTrue(app.buttons["yoloWarning.confirm"].waitForExistence(timeout: 5))
        app.buttons["yoloWarning.confirm"].tap()
        XCTAssertEqual(app.buttons["newChat.tools"].value as? String, "Works on its own")
        app.buttons["newChat.tools"].tap()
        XCTAssertTrue(app.buttons["tools.guardrails"].exists)
        app.buttons["tools.yolo"].tap()
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

    /// The same fixture and assertions are overlaid on the unchanged base for evidence.
    func testAutomaticRoutingAndManualOverride() {
        let app = launch(["-uiTestAutomatic"])
        let computer = app.buttons["newChat.computer"]
        XCTAssertTrue(computer.waitForExistence(timeout: 10))
        if ProcessInfo.processInfo.environment["NEKKO_AUTOMATIC_BASELINE"] != "1" {
            let picked = NSPredicate(format: "label CONTAINS %@", "Auto · Studio Mac")
            expectation(for: picked, evaluatedWith: computer)
            waitForExpectations(timeout: 10)
            XCTAssertTrue(app.staticTexts["newChat.auto"].label.contains("MacBook is busy"))
            XCTAssertTrue(app.buttons["newChat.model"].label.contains("qwen3:8b"))
        }
        attach(app, "automatic-new-chat")
        computer.tap()
        attach(app, "automatic-run-on-menu")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "MacBook")).firstMatch.tap()
        XCTAssertFalse(computer.label.contains("Auto"))
        XCTAssertFalse(app.staticTexts["newChat.auto"].exists)
        attach(app, "automatic-manual-macbook")
    }

    func testAutomaticAllBusyFallback() {
        let app = launch(["-uiTestAutomatic", "-uiTestAllBusy"])
        let computer = app.buttons["newChat.computer"]
        XCTAssertTrue(computer.waitForExistence(timeout: 10))
        if ProcessInfo.processInfo.environment["NEKKO_AUTOMATIC_BASELINE"] != "1" {
            let line = app.staticTexts["newChat.auto"]
            let fallback = NSPredicate(format: "label CONTAINS %@", "Every computer is busy")
            expectation(for: fallback, evaluatedWith: line)
            waitForExpectations(timeout: 10)
            XCTAssertTrue(computer.label.contains("MacBook"))
        }
        attach(app, "automatic-all-busy")
    }

    func testAutomaticStartWaitsForProbe() throws {
        guard ProcessInfo.processInfo.environment["NEKKO_AUTOMATIC_BASELINE"] != "1" else { throw XCTSkip("Before state has no Automatic") }
        let app = launch(["-uiTestAutomatic", "-uiTestSlowAuto"])
        let line = app.staticTexts["newChat.auto"]
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertTrue(line.label.contains("Finding a free computer"))
        XCTAssertFalse(app.buttons["newChat.start"].isEnabled)
        let picked = NSPredicate(format: "label CONTAINS %@", "MacBook is busy")
        expectation(for: picked, evaluatedWith: line)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(app.buttons["newChat.start"].isEnabled)
    }

    private func option(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND NOT identifier BEGINSWITH %@", title, "newChat.")).firstMatch
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestNewChat", "-expertMode", "YES",
                               "-skipYoloWarning", "NO"] + extra
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
