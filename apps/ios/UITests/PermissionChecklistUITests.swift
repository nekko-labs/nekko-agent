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
        // iOS owns the deep-link destination. If it opens Settings home,
        // exercise the same public Apps → Nekko Agent recovery path a user has.
        if !toggle.waitForExistence(timeout: 5) {
            let apps = settings.buttons["Apps"]
            for _ in 0..<12 {
                if apps.exists && apps.isHittable { break }
                settings.swipeUp()
            }
            XCTAssertTrue(apps.exists)
            apps.tap()
            let search = settings.searchFields.firstMatch
            if search.waitForExistence(timeout: 5) {
                search.tap()
                search.typeText("Nekko Agent")
            }
            let nekko = settings.staticTexts["Nekko Agent"].firstMatch
            XCTAssertTrue(nekko.waitForExistence(timeout: 10))
            nekko.tap()
        }
        guard toggle.waitForExistence(timeout: 10) else {
            attach(settings, "permissions-system-settings-unavailable")
            XCTFail("The public app-settings link did not expose Microphone")
            return
        }
        XCTAssertEqual(toggle.value as? String, "0")
        // Settings exposes the entire label row as a Switch on iOS 26.
        // Tap its trailing control, not the row's inert label center.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let enabled = expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: toggle)
        wait(for: [enabled], timeout: 5)
        app.activate()
        let microphoneStatus = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch
        let restored = expectation(for: NSPredicate(format: "label == %@", "Allowed"), evaluatedWith: microphoneStatus)
        wait(for: [restored], timeout: 10)
        attach(app, "permissions-microphone-restored")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
