import XCTest

/// The agent details' Model Server section, against `ModelServerFixture`
/// (`-uiTestModelServer`): fixed values, no computer.
@MainActor
final class ModelServerTests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestModelServer", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-expertMode", "YES"] + extra
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Safe on the base revision too (only this file is copied there): it
    /// photographs the section and asserts only what both revisions have.
    func testModelServerSectionEvidence() {
        let app = launch()
        XCTAssertTrue(app.switches["monitor.jitLoad"].waitForExistence(timeout: 10), "the Model Server section shows")
        capture(app, "model-server-section")
        let locked = launch(["-uiTestModelServerLocked"])
        XCTAssertTrue(locked.switches["monitor.jitLoad"].waitForExistence(timeout: 10))
        capture(locked, "model-server-section-locked")
    }

    /// Overload protection sits with the other settings, on unless the computer
    /// turned it off, and follows the same lock as they do.
    func testOverloadProtectionIsOnAndFollowsTheLock() {
        let app = launch()
        let guardSwitch = app.switches["monitor.overloadGuard"]
        XCTAssertTrue(guardSwitch.waitForExistence(timeout: 10), "Overload protection is in the Model Server section")
        XCTAssertEqual(guardSwitch.value as? String, "1", "on unless the computer says otherwise")
        XCTAssertTrue(guardSwitch.isEnabled)
        let locked = launch(["-uiTestModelServerLocked"])
        let lockedSwitch = locked.switches["monitor.overloadGuard"]
        XCTAssertTrue(lockedSwitch.waitForExistence(timeout: 10))
        XCTAssertFalse(lockedSwitch.isEnabled, "a computer that keeps its own model settings locks it like the rest")
    }
}
