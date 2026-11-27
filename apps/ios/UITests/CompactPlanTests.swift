import XCTest

@MainActor
final class CompactPlanTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestTurnDetails", "-planFixture", "-planDisplay", "balanced", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["chat.planFolded"].waitForExistence(timeout: 15))
        return app
    }

    func testComposerEvidence() {
        let app = launch()
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "compact-plan-composer"
        image.lifetime = .keepAlways
        add(image)
    }

    func testCompactRowsAndHistory() {
        let app = launch()
        let row = { (id: String) in app.descendants(matching: .any)["chat.planStep.\(id)"].firstMatch }
        XCTAssertTrue(row("compare").exists)
        XCTAssertTrue(row("review").exists)
        XCTAssertLessThan(row("review").frame.midY - row("compare").frame.midY, 48, "Upcoming rows must stay compact above the composer")
        XCTAssertFalse(row("ship").exists)
        XCTAssertFalse(app.staticTexts["Read the importer"].exists)
        app.buttons["chat.planCompleted"].tap()
        XCTAssertTrue(app.staticTexts["Read the importer"].waitForExistence(timeout: 5))
        app.buttons["chat.planCompleted"].tap()
        XCTAssertFalse(app.staticTexts["Read the importer"].exists)
        app.buttons["chat.planFolded"].tap()
        XCTAssertTrue(row("ship").waitForExistence(timeout: 5))
        app.descendants(matching: .any)["chat.planCompleted"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Read the importer"].waitForExistence(timeout: 5))
        app.buttons["Configure plan display"].tap()
        app.buttons["Show 1 row"].tap()
        XCTAssertTrue(app.buttons["chat.planFolded"].waitForExistence(timeout: 5))
        XCTAssertFalse(row("compare").exists)
        app.buttons["Configure plan display"].tap()
        app.buttons["Hide entirely"].tap()
        XCTAssertFalse(app.buttons["chat.planFolded"].exists)
    }
}
