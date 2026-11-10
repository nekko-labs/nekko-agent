import XCTest

/// Overlay this file alone on both app revisions with native-mode-evidence.yml.
/// Uses only pre-existing launch flags, fixture rows and accessibility identifiers.
@MainActor
final class WinterThemeTests: XCTestCase {
    func testWinterThemeEvidence() {
        for theme in ["light", "winter", "autumn"] {
            let app = launch(theme: theme, reduced: true)
            let mascot = app.buttons["chats.mascot"]
            XCTAssertTrue(mascot.waitForExistence(timeout: 15))
            XCTAssertTrue(app.navigationBars["Chats"].exists)
            attach(app, "seasonal-\(theme)-static")
            XCTAssertGreaterThanOrEqual(mascot.frame.width, 44)
            mascot.tap()
            XCTAssertTrue(waitValue(mascot, "Hello!", timeout: 2), "the hat does not intercept greeting")
            attach(app, "seasonal-\(theme)-hello")
            XCTAssertTrue(waitValue(mascot, "Working", timeout: 4))
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.80))
            from.press(forDuration: 0.1, thenDragTo: to)
            XCTAssertTrue(waitValue(mascot, "Refreshing", timeout: 2), "snow does not consume the refresh gesture")
            attach(app, "seasonal-\(theme)-refresh")
            XCTAssertTrue(waitValue(mascot, "Working", timeout: 8))
            app.terminate()
        }

        let app = launch(theme: "winter", reduced: false)
        XCTAssertTrue(app.buttons["chats.mascot"].waitForExistence(timeout: 15))
        // These frames aid inspection, but are not a substitute for a simctl recording.
        attach(app, "seasonal-winter-motion-start")
        Thread.sleep(forTimeInterval: 3)
        attach(app, "seasonal-winter-motion-end")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        app.activate()
        XCTAssertTrue(app.buttons["chats.mascot"].waitForExistence(timeout: 5))
        attach(app, "seasonal-winter-resumed")
        app.terminate()
    }

    private func launch(theme: String, reduced: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatStatus", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-uiTestReset", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", theme]
        if reduced { app.launchArguments.append("-uiTestReduceMotion") }
        app.launch()
        return app
    }

    private func waitValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval) -> Bool {
        // Greeting and fixture refresh last 1.2s; predicate expectations poll too slowly.
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element.value as? String == value { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while Date() < deadline
        return false
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
