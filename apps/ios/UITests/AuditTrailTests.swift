import XCTest

/// A chat's audit trail on the iPhone (More → Audit trail), against the
/// in-memory computer of `TurnDetailsFixture`: no sockets, secrets or real data.
@MainActor
final class AuditTrailTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestTurnDetails", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}"]
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func openMore(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The focused tests pass")).firstMatch.waitForExistence(timeout: 10))
        let more = app.buttons["chat.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()
    }

    /// Safe on the base revision too (only this file is copied there): it
    /// photographs the More menu, and opens the trail only where it exists.
    func testCaptureAuditTrailEvidence() {
        let app = launch()
        openMore(app)
        _ = app.buttons["Refresh"].waitForExistence(timeout: 5)
        capture(app, "audit-trail-ios-menu")
        let entry = app.buttons["chat.audit"]
        guard entry.exists else { return }
        entry.tap()
        XCTAssertTrue(app.descendants(matching: .any)["audit.trail"].waitForExistence(timeout: 10))
        capture(app, "audit-trail-ios-everything")
        app.segmentedControls["audit.filter"].buttons.element(boundBy: 1).tap()
        capture(app, "audit-trail-ios-approvals")
    }

    func testNamesWhoAllowedEachCall() {
        let app = launch()
        openMore(app)
        let entry = app.buttons["chat.audit"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(app.descendants(matching: .any)["audit.trail"].waitForExistence(timeout: 10))
        let has = { (text: String) in app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists }
        XCTAssertTrue(has("on Test iPhone (phone)"))
        XCTAssertTrue(has("on a paired computer (dev_c04e12)"))
        XCTAssertTrue(has("by YOLO, without asking"))
        XCTAssertFalse(has("dev_7f3a91"), "a named device shows its name, not its id")
        app.segmentedControls["audit.filter"].buttons.element(boundBy: 1).tap()
        XCTAssertFalse(has("Ran read_file"), "Approvals shows only the decisions")
        XCTAssertTrue(has("on Test iPhone (phone)"))
    }
}
