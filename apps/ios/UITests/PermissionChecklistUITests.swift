import XCTest

@MainActor
final class PermissionChecklistUITests: XCTestCase {
    private func launch(settings: Bool = false, largeText: Bool = false, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-uiTestReset", "YES", "-theme", dark ? "dark" : "light",
                               settings ? "-uiTestPermissionsSettings" : "-uiTestNotificationStep"]
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        return app
    }

    func testOnboardingCanContinueWithoutRequestingAccess() {
        let app = launch()
        let next = app.buttons["permissions.continue"]
        XCTAssertTrue(next.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["permissions.action.notifications"].exists)
        XCTAssertTrue(app.buttons["permissions.action.network"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        attach(app, "permissions-onboarding")
        next.tap()
        // The isolated route intentionally does not load stores/start transports.
        // Prove dismissal, not a downstream screen dependent on startup.
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: next)
        wait(for: [dismissed], timeout: 10)
        XCTAssertFalse(app.alerts.firstMatch.exists)
    }

    func testAllPermissionsAreReachableWithLargestText() {
        let app = launch(largeText: true)
        XCTAssertTrue(app.buttons["permissions.continue"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["permissions.continue"].isHittable)
        attach(app, "permissions-large-text-top")
        for name in ["notifications", "network", "liveActivities", "camera", "microphone", "speech", "authentication", "photos"] {
            let action = app.buttons["permissions.action.\(name)"]
            for _ in 0..<14 {
                if action.exists && action.isHittable { break }
                app.swipeUp()
            }
            XCTAssertTrue(action.exists, "\(name) is present")
            XCTAssertTrue(action.isHittable, "\(name) is reachable")
        }
        attach(app, "permissions-large-text-bottom")
        XCTAssertTrue(app.buttons["permissions.continue"].isHittable)
        XCTAssertFalse(app.alerts.firstMatch.exists)
    }

    func testSettingsEntryReusesChecklistWithoutOnboardingCTA() {
        let app = launch(settings: true, dark: true)
        let link = app.buttons["settings.permissions"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        for _ in 0..<5 {
            if link.isHittable { break }
            app.swipeUp()
        }
        link.tap()
        XCTAssertTrue(app.buttons["permissions.action.notifications"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["permissions.continue"].exists)
        XCTAssertFalse(app.staticTexts["Step 3 of 3"].exists)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        attach(app, "permissions-settings-dark")
    }

    func testMicrophoneDenialAndSettingsRecovery() {
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .microphone)
        app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-uiTestReset", "YES", "-theme", "light", "-uiTestNotificationStep"]
        app.launch()
        let microphone = app.buttons["permissions.action.microphone"]
        XCTAssertTrue(app.buttons["permissions.continue"].waitForExistence(timeout: 15))
        for _ in 0..<10 {
            if microphone.exists && microphone.isHittable { break }
            app.swipeUp()
        }
        microphone.tap()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = system.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        let deny = alert.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Don")).firstMatch
        XCTAssertTrue(deny.exists)
        deny.tap()
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        XCTAssertTrue(microphone.label.hasPrefix("Settings:"))
        attach(app, "permissions-microphone-denied")
        microphone.tap()
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        let toggle = settings.switches["Microphone"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, "0")
        toggle.tap()
        app.activate()
        let granted = app.staticTexts["Allowed"]
        XCTAssertTrue(granted.firstMatch.waitForExistence(timeout: 10))
        let row = app.descendants(matching: .any)["permissions.row.microphone"].firstMatch
        XCTAssertTrue(row.staticTexts["Allowed"].exists)
        attach(app, "permissions-microphone-restored")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
