import XCTest

/// Same seeded real ChatView on both app revisions. The baseline has no YOLO
/// warning, so its after-selection state is captured rather than a fabricated dialog.
@MainActor
final class SecurityComparisonTests: XCTestCase {
    func testSecurityComparison() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestSecurityEvidence", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}", "-skipYoloWarning", "NO",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.buttons["Deny"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Allow"].exists)
        let always = app.buttons["approval.alwaysAllow"]
        let hasAlways = always.exists
        if hasAlways { XCTAssertEqual(always.label, "Always allow this tool") }
        attach(app, "security-approval")
        let picker = app.buttons["chat.asksFirst"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        let yolo = app.buttons["tools.yolo"]
        XCTAssertTrue(yolo.waitForExistence(timeout: 5))
        yolo.tap()
        if hasAlways {
            XCTAssertTrue(app.buttons["yoloWarning.confirm"].waitForExistence(timeout: 5))
        } else {
            XCTAssertFalse(app.buttons["yoloWarning.confirm"].waitForExistence(timeout: 3))
        }
        attach(app, hasAlways ? "security-yolo-warning" : "security-yolo-before-no-warning")
    }
    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
