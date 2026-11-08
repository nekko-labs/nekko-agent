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
        // One row is open at a time; the rest are compact and tappable.
        XCTAssertTrue(app.buttons["permissions.row.network"].exists)
        XCTAssertFalse(app.buttons["permissions.action.network"].exists)
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
            let row = app.buttons["permissions.row.\(name)"]
            let action = app.buttons["permissions.action.\(name)"]
            reveal(row, in: app)
            if !action.exists { row.tap() }
            XCTAssertTrue(action.waitForExistence(timeout: 3), "\(name) opens")
            reveal(action, in: app)
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
        let row = app.buttons["permissions.row.microphone"]
        XCTAssertTrue(app.buttons["permissions.continue"].waitForExistence(timeout: 15))
        for _ in 0..<10 {
            if row.exists && row.isHittable { break }
            app.swipeUp()
        }
        row.tap()
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        if !microphone.isHittable { app.swipeUp() }
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

    func testGrantChecksOffTheRowAndOpensTheNext() {
        let app = XCUIApplication()
        // Notifications cannot be reset from XCUITest; the microphone can.
        app.resetAuthorizationStatus(for: .microphone)
        app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-uiTestReset", "YES", "-theme", "light", "-uiTestNotificationStep"]
        app.launch()
        let row = app.buttons["permissions.row.microphone"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        reveal(row, in: app)
        row.tap()
        let allow = app.buttons["permissions.action.microphone"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        reveal(allow, in: app)
        allow.tap()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        alert.buttons["Allow"].tap()
        let status = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch
        wait(for: [expectation(for: NSPredicate(format: "label == %@", "Allowed"), evaluatedWith: status)], timeout: 10)
        // The next unfinished row below opens on its own, not the top of the list.
        XCTAssertTrue(app.buttons["permissions.action.speech"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["permissions.action.microphone"].exists)
        attach(app, "permissions-granted")
    }

    func testNotNowChecksOffTheRowAndOpensTheNext() {
        let app = launch()
        let skip = app.buttons["permissions.skip.notifications"]
        XCTAssertTrue(skip.waitForExistence(timeout: 15))
        skip.tap()
        XCTAssertTrue(app.buttons["permissions.action.network"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["permissions.action.notifications"].exists)
        XCTAssertEqual(app.buttons["permissions.row.notifications"].value as? String, "Skipped")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        attach(app, "permissions-advanced")
    }

    /// Short drags toward the element; a full swipe can jump past a row at the largest text size.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<24 {
            // isHittable is true under the pinned Continue bar too; a tap there finishes onboarding.
            let bar = app.buttons["permissions.continue"]
            let floor = bar.exists ? bar.frame.minY - 12 : app.frame.maxY
            if element.exists && element.isHittable && element.frame.maxY < floor { return }
            let up = !element.exists || element.frame.maxY >= floor
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.6 : 0.4))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.35 : 0.65)),
                       withVelocity: .slow, thenHoldForDuration: 0.2)
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
