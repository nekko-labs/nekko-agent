import XCTest

/// Strict, common before/after evidence harness. No product behavior is overlaid.
@MainActor
final class PermissionReturnTimingTests: XCTestCase {
    func testSettingsReturnReportsAllowedWithinTenSeconds() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] != nil,
                          "Strict return timing belongs to disposable matched evidence simulators")
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
        guard reveal(target, in: app) else { return }
        if expandable { row.tap() }
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        guard reveal(microphone, in: app) else { return }
        XCTAssertTrue(microphone.label.hasPrefix("Allow"), "The unasked microphone request is shown before denial")
        // isHittable alone can accept a control hidden behind the pinned footer.
        // Record the actual frame and pixels before the deliberate request tap.
        attach(app, "permissions-microphone-before-request")
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
        // The same public XCTest return action runs on both app revisions. Never
        // select launch/activate from the observed process state or force a grant.
        let resumeState = app.state
        let microphoneStatus = app.descendants(matching: .any)["permissions.status.microphone"].firstMatch
        let restored = expectation(for: NSPredicate(format: "exists == true AND label == %@", "Allowed"), evaluatedWith: microphoneStatus)
        let returnBudget: TimeInterval = 10
        let returnStarted = ProcessInfo.processInfo.systemUptime
        app.activate()
        let activationElapsed = ProcessInfo.processInfo.systemUptime - returnStarted
        let remaining = max(0, returnBudget - activationElapsed)
        let result = XCTWaiter.wait(for: [restored], timeout: remaining)
        let allowedElapsed = ProcessInfo.processInfo.systemUptime - returnStarted
        // Assertion time includes activation, automation-session setup and the AX
        // predicate. Expensive evidence capture happens only AFTER this boundary.
        XCTAssertEqual(result, .completed, "The returned fixture must report Allowed in the single return budget")
        XCTAssertLessThanOrEqual(allowedElapsed, returnBudget, "Settings return through Allowed, including activation, must finish within ten seconds")
        let process = XCTAttachment(string: "beforeSettingsReturn=\(resumeState.rawValue); returnAction=activate; activationSeconds=\(activationElapsed); allowedSeconds=\(allowedElapsed); budgetSeconds=\(returnBudget); waiter=\(result.rawValue); afterSettingsReturn=\(app.state.rawValue)")
        process.name = "permissions-settings-return-timing"
        process.lifetime = .keepAlways
        add(process)
        attach(app, "permissions-settings-return")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "permissions-settings-return-accessibility"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTAssertTrue(microphoneStatus.exists, "The same permission fixture must return after Settings")
        XCTAssertEqual(microphoneStatus.label, "Allowed")
        attach(app, "permissions-microphone-restored")
    }

    /// Setup only: the total Settings-return clock below is never changed here.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        let scroll = app.scrollViews.firstMatch
        let footer = app.buttons["permissions.continue"]
        func fullyVisible() -> Bool {
            guard element.exists && element.isHittable && scroll.exists && footer.exists else { return false }
            let viewport = scroll.frame.intersection(app.frame)
            let frame = element.frame
            let bottom = min(viewport.maxY, footer.frame.minY) - 8
            return frame.width > 0 && frame.height > 0
                && frame.minX >= viewport.minX && frame.maxX <= viewport.maxX
                && frame.minY >= viewport.minY + 8 && frame.maxY <= bottom
        }
        for _ in 0..<10 {
            if fullyVisible() { break }
            scroll.swipeUp()
        }
        let geometry = XCTAttachment(string: "target=\(element.identifier); frame=\(element.frame); scroll=\(scroll.frame); footer=\(footer.frame); fullyVisible=\(fullyVisible())")
        geometry.name = "permissions-microphone-target-geometry"
        geometry.lifetime = .keepAlways
        add(geometry)
        guard fullyVisible() else {
            attach(app, "permissions-microphone-request-unreachable")
            XCTFail("The microphone target must be fully inside the scroll viewport above Continue before tapping")
            return false
        }
        return true
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
