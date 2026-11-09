import XCTest

/// Diagnostic only: identical production views and assertions at two input velocities.
/// Uses the existing in-memory computer fixture, without a relay or real user data.
@MainActor
final class PillVelocityDiagnosticTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testFastRightTuck() { rightTuck(velocity: .fast, name: "fast") }
    func testMeasuredRightTuck() { rightTuck(velocity: XCUIGestureVelocity(rawValue: 200), name: "200pt-per-second") }

    private func rightTuck(velocity: XCUIGestureVelocity, name: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "YES", "-uiTestReset", "YES",
                               "-pillPlacement", "across:0.0", "-uiTestChatRefresh", "-uiTestLocalModel",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        defer { app.terminate() }
        let panel = app.buttons["chat.monitor"]
        let tab = app.buttons["chat.pill.tab"]
        let window = app.windows.firstMatch
        XCTAssertTrue(panel.waitForExistence(timeout: 20))
        pause()
        panel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.7, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.4)))
        pause()
        XCTAssertGreaterThan(panel.frame.midX, window.frame.width * 0.7, "the pill docks on the right")
        XCTAssertGreaterThan(panel.frame.height, panel.frame.width, "the gauges stack")
        attach(app, name + "-before")

        let start = panel.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        let end = start.withOffset(CGVector(dx: window.frame.maxX - 1 - start.screenPoint.x, dy: 0))
        let distance = end.screenPoint.x - start.screenPoint.x
        XCTAssertGreaterThan(distance, 24, "the swipe crosses the unchanged tuck threshold")
        let trace = XCTAttachment(string: "velocity=\(velocity.rawValue) start=\(start.screenPoint) end=\(end.screenPoint) distance=\(distance) panel=\(panel.frame)")
        trace.name = name + "-input"
        trace.lifetime = .keepAlways
        add(trace)
        start.press(forDuration: 0.01, thenDragTo: end, withVelocity: velocity, thenHoldForDuration: 0)
        let tucked = tab.waitForExistence(timeout: 5)
        attach(app, name + "-after")
        XCTAssertTrue(tucked, "a swipe into the side tucks the pill away")
        XCTAssertFalse(app.buttons["monitor.sheet"].exists, "a tuck swipe does not open monitor details")
        XCTAssertFalse(panel.exists)
        tab.tap()
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "the tab restores the pill")
        pause()
        attach(app, name + "-restored")
    }

    private func pause() { RunLoop.current.run(until: Date().addingTimeInterval(1)) }
    private func attach(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-full-accessibility-tree"
        tree.lifetime = .keepAlways
        add(tree)
    }
}
