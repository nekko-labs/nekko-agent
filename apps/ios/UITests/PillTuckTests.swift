import XCTest

/// The production chat and pill over the existing in-memory computer fixture.
/// Run the same harness on the merge base with NEKKO_PILL_BASELINE=1 for matched evidence.
@MainActor
final class PillTuckTests: XCTestCase {
    func testTuckAndRestoreAtTheTopAndRightEdge() {
        let baseline = ProcessInfo.processInfo.environment["NEKKO_PILL_BASELINE"] == "1"
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "YES", "-uiTestReset", "YES",
                               "-pillPlacement", "across:0.0", "-uiTestChatRefresh", "-uiTestLocalModel",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        let pill = app.descendants(matching: .any)["chat.pill"].firstMatch
        let tab = app.buttons["chat.pill.tab"]
        let window = app.windows.firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 20))
        pause()
        shot(app, "pill-top-initial")
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.01, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)), withVelocity: .fast, thenHoldForDuration: 0)
        pause()
        shot(app, "pill-top-after-swipe")
        if baseline {
            XCTAssertFalse(tab.exists)
            XCTAssertTrue(pill.exists)
        } else {
            XCTAssertTrue(tab.waitForExistence(timeout: 5))
            XCTAssertFalse(pill.exists)
            XCTAssertGreaterThanOrEqual(tab.frame.height, 44)
            tab.tap()
            XCTAssertTrue(pill.waitForExistence(timeout: 5))
            pause()
            shot(app, "pill-top-restored")
        }
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.7, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.4)))
        pause()
        XCTAssertGreaterThan(pill.frame.midX, window.frame.width * 0.7)
        shot(app, "pill-right-initial")
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.01, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.995, dy: 0.4)), withVelocity: .fast, thenHoldForDuration: 0)
        pause()
        shot(app, "pill-right-after-swipe")
        if baseline {
            XCTAssertFalse(tab.exists)
            XCTAssertTrue(pill.exists)
        } else {
            XCTAssertTrue(tab.waitForExistence(timeout: 5))
            XCTAssertFalse(pill.exists)
            XCTAssertGreaterThanOrEqual(tab.frame.width, 44)
            // An outward swipe also restores the pill, independently of the top tab's tap.
            tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .press(forDuration: 0.01, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.4)), withVelocity: .fast, thenHoldForDuration: 0)
            XCTAssertTrue(pill.waitForExistence(timeout: 5))
            pause()
            shot(app, "pill-right-restored")
        }
        app.terminate()
    }

    private func pause() { RunLoop.current.run(until: Date().addingTimeInterval(1)) }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
