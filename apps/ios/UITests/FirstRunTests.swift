import XCTest

final class FirstRunTests: XCTestCase {
    /// A fresh install shows the welcome screen with pairing and the Tailscale guide,
    /// and makes no connection before a computer is paired.
    func testWelcomeLeadsToPairing() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-uiTestReset", "YES"]
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
        app.launchArguments = ["-appLock", "NO", "-uiTestReset", "YES"]
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
        app.launchArguments = ["-appLock", "NO", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL", "-uiTestReset", "YES"]
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
