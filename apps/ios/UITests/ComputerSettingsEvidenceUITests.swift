import XCTest

@MainActor
final class ComputerSettingsEvidenceUITests: XCTestCase {
    private var baseline: Bool { ProcessInfo.processInfo.environment["NEKKO_COMPUTER_BASELINE"] == "1" }

    func testModelsEvidenceAndFilters() {
        let app = launch()
        openComputer(app)
        let list = app.collectionViews.firstMatch
        let models = app.descendants(matching: .any)["computer.models"]
        if baseline {
            let heading = app.staticTexts["Models"]
            scrollTo(heading, in: list)
            XCTAssertTrue(heading.waitForExistence(timeout: 10))
            XCTAssertTrue(app.staticTexts["Claude Opus"].exists)
            attach(app, "computer-models-default")
            return
        }
        scrollTo(models, in: list)
        XCTAssertTrue(models.waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Claude Opus"].exists)
        XCTAssertFalse(app.staticTexts["Qwen3 8B"].exists)
        attach(app, "computer-models-default")
        models.tap()
        let cloud = app.buttons["Cloud"]
        XCTAssertTrue(cloud.waitForExistence(timeout: 5))
        attach(app, "computer-models-expanded")
        cloud.tap()
        XCTAssertTrue(app.staticTexts["Claude Opus"].exists)
        XCTAssertFalse(app.staticTexts["Qwen3 8B"].exists)
        app.buttons["Local"].tap()
        XCTAssertTrue(app.staticTexts["Qwen3 8B"].exists)
        XCTAssertFalse(app.staticTexts["Claude Opus"].exists)
        app.buttons["All"].tap()
        XCTAssertTrue(app.staticTexts["Claude Opus"].exists)
        XCTAssertTrue(app.staticTexts["Qwen3 8B"].exists)
    }

    func testDisconnectPersistsAcrossDetailNavigation() throws {
        if baseline { throw XCTSkip("Connection controls are new") }
        let app = launch()
        let toggle = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@", "computer.connection.")).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, "1")
        // SwiftUI exposes the labelled row as a switch; tap the trailing switch itself.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "0")
        openComputer(app)
        let detailToggle = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@", "computer.connection.")).firstMatch
        XCTAssertTrue(detailToggle.waitForExistence(timeout: 5))
        XCTAssertEqual(detailToggle.value as? String, "0")
        XCTAssertFalse(app.buttons["computer.reconnect"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertEqual(toggle.value as? String, "0")
        attach(app, "computer-disconnected")
    }

    func testServiceOptInAndRestartConfirmation() throws {
        if baseline { throw XCTSkip("Service controls are new") }
        let app = launch()
        openComputer(app)
        let list = app.collectionViews.firstMatch
        let instructions = app.staticTexts["service.optInInstructions"]
        scrollTo(instructions, in: list)
        XCTAssertTrue(instructions.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["service.restart"].exists)
        attach(app, "computer-service-opt-in-off")
        app.terminate()
        let enabled = launch(["-uiTestServiceEnabled"])
        openComputer(enabled)
        let restart = enabled.buttons["service.restart"]
        scrollTo(restart, in: enabled.collectionViews.firstMatch)
        XCTAssertTrue(restart.waitForExistence(timeout: 10))
        XCTAssertTrue(restart.isEnabled)
        restart.tap()
        XCTAssertTrue(enabled.buttons["Cancel"].waitForExistence(timeout: 5))
        XCTAssertTrue(enabled.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "not the computer")).firstMatch.exists)
        attach(enabled, "computer-service-restart-confirmation")
        enabled.buttons["Cancel"].tap()
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestComputerSettingsEvidence"] + extra
        app.launch()
        return app
    }
    private func openComputer(_ app: XCUIApplication) {
        let row = app.buttons["computers.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }
    private func scrollTo(_ element: XCUIElement, in list: XCUIElement) {
        for _ in 0..<12 where !element.isHittable { list.swipeUp() }
    }
    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
