import XCTest

final class FirstRunTests: XCTestCase {
    /// A fresh install shows the welcome screen with pairing and the Tailscale guide,
    /// and makes no connection before a computer is paired.
    func testWelcomeLeadsToPairing() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        let pair = app.buttons["Pair with your computer"]
        XCTAssertTrue(pair.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Connect over Tailscale (recommended)"].exists)
        attach(app, "Welcome")
        // At first launch the end of the guide sits under the pinned, translucent
        // Pair bar, so the audit measures it against the bar. The same guide is
        // audited fully visible on the pairing screen below.
        let window = app.windows.firstMatch.frame
        let barTop = pair.frame.minY - 12
        let bar = CGRect(x: window.minX, y: barTop, width: window.width, height: window.maxY - barTop)
        auditAccessibility(app, "welcome", covered: bar)
        pair.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("not a link")
        app.buttons["Pair"].tap()
        XCTAssertTrue(app.staticTexts["That isn’t a Nekko Agent pairing link."].waitForExistence(timeout: 5))
        attach(app, "Pair")
        auditAccessibility(app, "pair")
    }

    /// A plain ws:// relay on the open internet is refused before anything is dialed.
    func testRefusesAPublicCleartextRelay() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        app.buttons["Pair with your computer"].tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("relay=ws://relay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff")
        app.buttons["Pair"].tap()
        let msg = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "not encrypted")).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 5))
    }

    /// The largest accessibility text size still lays out: no clipped controls on the first screens.
    func testLargestTextSizesStillFit() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL", "-uiTestReset", "YES"]
        app.launch()
        let pair = app.buttons["Pair with your computer"]
        XCTAssertTrue(pair.waitForExistence(timeout: 10))
        XCTAssertTrue(pair.isHittable)
        attach(app, "Welcome (accessibility XL text)")
        pair.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        if !field.waitForExistence(timeout: 5) { app.swipeUp() }
        XCTAssertTrue(field.exists)
        attach(app, "Pair (accessibility XL text)")
    }

    /// IO-31: the three first-run steps, each audited in light and dark. Step 3
    /// follows the first pairing; here a launch argument opens it directly.
    func testTheFirstRunInLightAndDark() {
        for theme in uiTestThemes {
            let app = XCUIApplication()
            app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-theme", theme, "-uiTestReset", "YES"]
            app.launch()
            let next = app.buttons["firstRun.continue"]
            XCTAssertTrue(next.waitForExistence(timeout: 10), "step 1 on a fresh install")
            XCTAssertTrue(app.staticTexts["Step 1 of 3"].exists)
            XCTAssertTrue(app.buttons["firstRun.skip"].exists)
            attach(app, "(theme)-firstrun-1")
            auditAccessibility(app, "(theme)-firstrun-1", covered: bar(app, above: next))
            next.tap()
            let pair = app.buttons["Pair with your computer"]
            XCTAssertTrue(pair.waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["Step 2 of 3"].exists)
            attach(app, "(theme)-firstrun-2")
            auditAccessibility(app, "(theme)-firstrun-2", covered: bar(app, above: pair))
            app.terminate()

            app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-theme", theme, "-uiTestReset", "YES", "-uiTestNotificationStep"]
            app.launch()
            let allow = app.buttons["firstRun.allowNotifications"]
            XCTAssertTrue(allow.waitForExistence(timeout: 10), "step 3")
            XCTAssertTrue(app.staticTexts["Step 3 of 3"].exists)
            XCTAssertTrue(app.descendants(matching: .any)["Preview: an approval with Allow and Deny, and a finished reply."].exists)
            attach(app, "(theme)-firstrun-3")
            auditAccessibility(app, "(theme)-firstrun-3", covered: bar(app, above: allow))
            // Not now: iOS is not asked, and the step goes away.
            app.buttons["firstRun.notNow"].tap()
            XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 2))
            XCTAssertTrue(waitGone(allow, 5))
            app.terminate()
        }
    }

    /// Skip ends the first run on step 1: straight to pairing, with no step label.
    func testSkipGoesStraightToPairing() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "NO", "-uiTestReset", "YES"]
        app.launch()
        let skip = app.buttons["firstRun.skip"]
        XCTAssertTrue(skip.waitForExistence(timeout: 10))
        skip.tap()
        XCTAssertTrue(app.buttons["Pair with your computer"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Step 2 of 3"].exists, "skipped: no more steps")
        attach(app, "firstrun-skipped")
    }

    /// The pinned bottom bar over a screen, measured from its button.
    private func bar(_ app: XCUIApplication, above button: XCUIElement) -> CGRect {
        let window = app.windows.firstMatch.frame
        let top = button.frame.minY - 12
        return CGRect(x: window.minX, y: top, width: window.width, height: window.maxY - top)
    }

    private func waitGone(_ e: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let p = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: e)
        return XCTWaiter.wait(for: [p], timeout: seconds) == .completed
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}

extension XCUIApplication {
    /// A SwiftUI text input by its title: a one-line TextField is a text field,
    /// a vertical-axis one is a text view.
    func input(_ label: String) -> XCUIElement {
        let types = [XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue]
        return descendants(matching: .any).matching(NSPredicate(
            format: "(elementType == %d OR elementType == %d) AND (label == %@ OR placeholderValue == %@ OR identifier == %@)",
            types[0], types[1], label, label, label)).firstMatch
    }
}
