import XCTest

/// #3346: the connection row without a page-wide Tailscale item, and the per-computer
/// "Connect through" choice. Run before and after with `--preset custom`; the baseline
/// has no choice, so it only captures the strip and the computer page.
@MainActor
final class RouteChoiceEvidenceUITests: XCTestCase {
    func testStripEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestConnectionStrip"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["connection-strip"].firstMatch.waitForExistence(timeout: 10))
        attach(app, "connection-strip")
    }

    func testConnectThroughEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestComputerSettingsEvidence", "-uiTestRouteChoice"]
        app.launch()
        let row = app.buttons["computers.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let list = app.collectionViews.firstMatch
        let tailscale = app.buttons["computer.connect-through.tailscale"]
        for _ in 0..<12 where !tailscale.isHittable && !app.staticTexts["Connection"].isHittable { list.swipeUp() }
        for _ in 0..<4 where !tailscale.exists { list.swipeUp() }
        attach(app, "computer-connection")
        guard tailscale.exists else { return } // the baseline has no choice
        attach(app, "connect-through-both")
        tailscale.tap()
        let cloud = app.buttons["computer.connect-through.cloud"]
        XCTAssertFalse(cloud.isEnabled, "the last one on stays on")
        attach(app, "connect-through-cloud-only")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
