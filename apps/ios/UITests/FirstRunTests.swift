import XCTest

final class FirstRunTests: XCTestCase {
    /// A fresh install shows the welcome screen with pairing and the Tailscale guide,
    /// and makes no connection before a computer is paired.
    func testWelcomeLeadsToPairing() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-appLock", "NO"]
        app.launch()
        let pair = app.buttons["Pair with your computer"]
        XCTAssertTrue(pair.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Connect over Tailscale (recommended)"].exists)
        attach(app, "Welcome")
        pair.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("not a link")
        app.buttons["Pair"].tap()
        XCTAssertTrue(app.staticTexts["That isn’t a Nekko Agent pairing link."].waitForExistence(timeout: 5))
        attach(app, "Pair")
    }

    /// A plain ws:// relay on the open internet is refused before anything is dialed.
    func testRefusesAPublicCleartextRelay() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-appLock", "NO"]
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
