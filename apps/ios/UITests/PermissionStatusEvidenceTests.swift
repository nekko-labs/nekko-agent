import XCTest

/// Diagnostic only: inspect and audit a real granted status on base and head.
@MainActor
final class PermissionStatusEvidenceTests: XCTestCase {
    func testAllowedNotificationStatusAudit() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-uiTestReset", "YES", "-theme", "light", "-uiTestNotificationStep"]
        app.launch()
        defer { app.terminate() }
        let action = app.buttons["permissions.action.notifications"]
        XCTAssertTrue(action.waitForExistence(timeout: 15))
        action.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 10) else {
            XCTFail("Fresh simulator must show its notification permission alert")
            return
        }
        let allow = alert.buttons.matching(NSPredicate(format: "label == %@", "Allow")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        allow.tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 5))
        // Base has a flat checklist; the guided feature collapses an allowed row.
        let row = app.buttons["permissions.row.notifications"]
        if row.exists, !action.exists { row.tap() }
        let status = app.descendants(matching: .any)["permissions.status.notifications"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let allowed = NSPredicate(format: "label == %@", "Allowed")
        expectation(for: allowed, evaluatedWith: status)
        waitForExpectations(timeout: 5)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "allowed-notification-status"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "allowed-status-full-accessibility-tree"
        tree.lifetime = .keepAlways
        add(tree)
        // No exemptions: retain every audit type and fail on actual findings.
        auditAccessibility(app, "allowed-notification-status")
    }
}
