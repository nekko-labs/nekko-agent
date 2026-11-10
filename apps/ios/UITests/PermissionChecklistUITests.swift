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
        // OS notification access survives -uiTestReset and may already be granted.
        // Open its details explicitly without requesting access.
        open("notifications", in: app)
        XCTAssertTrue(app.buttons["permissions.action.notifications"].exists)
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
        open("notifications", in: app)
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
        let row = app.descendants(matching: .any)["permissions.row.microphone"].firstMatch
        XCTAssertTrue(app.buttons["permissions.continue"].waitForExistence(timeout: 15))
        guard row.exists else {
            attach(app, "permissions-microphone-row-missing")
            XCTFail("The permission fixture must contain the microphone row")
            return
        }
        // Baseline c018 has an inline card (AX Other), not the repaired accordion Button.
        // Drive the same deliberate microphone request on both; never tap the baseline's
        // noninteractive container or assume a missing Button proves authorization failure.
        let expandable = row.elementType == .button
        let target = expandable ? row : microphone
        let route = XCTAttachment(string: "rowType=\(row.elementType.rawValue); requestPath=\(expandable ? "accordion" : "inline")")
        route.name = "permissions-microphone-request-path"
        route.lifetime = .keepAlways
        add(route)
        for _ in 0..<10 {
            if target.exists && target.isHittable { break }
            app.swipeUp()
        }
        guard target.exists && target.isHittable else {
            attach(app, "permissions-microphone-request-unreachable")
            XCTFail("The microphone request must be reachable without granting it")
            return
        }
        if expandable { row.tap() }
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        if !microphone.isHittable { app.swipeUp() }
        XCTAssertTrue(microphone.label.hasPrefix("Allow"), "The unasked microphone request is shown before denial")
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
        // Changing a TCC grant can terminate the app. Preserve the isolated
        // route/lock launch arguments on that fresh process, without forcing a
        // restart when the original process survives (foreground refresh case).
        let resumeState = app.state
        let process = XCTAttachment(string: "beforeSettingsReturn=\(resumeState.rawValue); relaunch=\(resumeState == .notRunning)")
        process.name = "permissions-settings-process-state"
        process.lifetime = .keepAlways
        add(process)
        if resumeState == .notRunning { app.launch() } else { app.activate() }
        attach(app, "permissions-settings-return")
        let microphoneStatus = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch
        XCTAssertTrue(microphoneStatus.waitForExistence(timeout: 10), "The same permission fixture must return after Settings")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "permissions-settings-return-accessibility"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        let restored = expectation(for: NSPredicate(format: "label == %@", "Allowed"), evaluatedWith: microphoneStatus)
        wait(for: [restored], timeout: 10)
        attach(app, "permissions-microphone-restored")
    }

    func testGrantChecksOffTheRowAndOpensTheNext() {
        let app = XCUIApplication()
        // Reset the microphone grant, independent of earlier suite tests.
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
        guard alert.waitForExistence(timeout: 10) else {
            XCTFail("Microphone request must show its system permission alert")
            return
        }
        // iOS 27 exposes nested buttons with this same TCC identifier.
        // Select the first representation of the actual microphone grant control.
        let grant = alert.buttons.matching(identifier: "kTCCServiceMicrophone-allow-button").firstMatch
        XCTAssertTrue(grant.waitForExistence(timeout: 5))
        grant.tap()
        let status = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch
        wait(for: [expectation(for: NSPredicate(format: "label == %@", "Allowed"), evaluatedWith: status)], timeout: 10)
        // The next unfinished row below opens on its own, not the top of the list.
        XCTAssertTrue(app.buttons["permissions.action.speech"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["permissions.action.microphone"].exists)
        attach(app, "permissions-granted")
    }

    func testNotNowChecksOffTheRowAndOpensTheNext() {
        // Notifications cannot be reset; microphone authorization can.
        let permissions = XCUIApplication()
        permissions.resetAuthorizationStatus(for: .microphone)
        let app = launch()
        open("microphone", in: app)
        let skip = app.buttons["permissions.skip.microphone"]
        XCTAssertTrue(skip.waitForExistence(timeout: 15))
        reveal(skip, in: app)
        skip.tap()
        XCTAssertTrue(app.buttons["permissions.action.speech"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["permissions.action.microphone"].exists)
        XCTAssertEqual(app.buttons["permissions.row.microphone"].value as? String, "Skipped")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        attach(app, "permissions-advanced")
    }

    private func open(_ name: String, in app: XCUIApplication) {
        let row = app.buttons["permissions.row.\(name)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let action = app.buttons["permissions.action.\(name)"]
        if !action.exists {
            reveal(row, in: app)
            row.tap()
        }
        XCTAssertTrue(action.waitForExistence(timeout: 5), "\(name) details open")
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
