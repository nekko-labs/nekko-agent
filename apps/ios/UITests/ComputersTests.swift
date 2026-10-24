import XCTest

final class ComputersTests: XCTestCase {
    /// A paired computer can be renamed and forgotten from a tap on its row in
    /// Computers, and forgotten from the computer menu on the chats screen.
    func testRenameAndForgetAComputer() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()

        pair(app)
        openMenu(app)
        app.buttons["Computers"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "relay.example.com")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))

        // The row opens the computer's page; Rename and Forget live in its Edit menu.
        row.tap()
        let edit = app.buttons["computer.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5), "the computer page's Edit menu")
        tapBarButton(edit, in: app)
        app.buttons["Rename"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.clearAndType("Studio")
        app.alerts.buttons["Save"].tap()
        let renamed = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Studio")).firstMatch
        XCTAssertTrue(renamed.waitForExistence(timeout: 5), "Rename saved")

        tapBarButton(edit, in: app)
        app.buttons["Forget…"].tap()
        confirmForget(app)
        XCTAssertTrue(app.staticTexts["This computer was forgotten"].waitForExistence(timeout: 5), "the page says the computer is gone")
        app.buttons["Computers"].firstMatch.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "Forget from the computer page removed the computer")

        // From the computer menu on the chats screen.
        app.terminate()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        pair(app)
        openMenu(app)
        let computer = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "computer")).element(boundBy: 0)
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        computer.tap()
        app.buttons["Forget…"].tap()
        confirmForget(app)
        XCTAssertTrue(app.buttons["Pair with your computer"].waitForExistence(timeout: 10), "Forget from the menu removed the only computer")
    }

    private func pair(_ app: XCUIApplication) {
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("relay=wss://relay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff")
        app.buttons["Pair"].tap()
        if app.buttons["Not now"].waitForExistence(timeout: 3) { app.buttons["Not now"].tap() }
        // Onboarded, pairing asks iOS for notifications straight away; answer it here
        // rather than inside the next tap's interruption handling.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
    }

    /// The computer menu, tapped by coordinate once it has a real frame: XCTest
    /// can't "scroll to" this navigation bar button (hit point {-1, -1}), as
    /// LiveRelayTests found for the same button.
    private func openMenu(_ app: XCUIApplication) {
        let m = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers and settings")).firstMatch
        XCTAssertTrue(m.waitForExistence(timeout: 10))
        tapBarButton(m, in: app)
    }

    /// Navigation-bar buttons (the computer menu, the computer page's Edit menu)
    /// have no hit point for XCTest's tap; tap their centre once they have a frame.
    private func tapBarButton(_ e: XCUIElement, in app: XCUIApplication) {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let f = e.frame
            if e.exists, !f.isEmpty, app.frame.contains(CGPoint(x: f.midX, y: f.midY)) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        e.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func confirmForget(_ app: XCUIApplication) {
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Forget")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the Forget confirmation")
        confirm.tap()
    }
}

private extension XCUIElement {
    func clearAndType(_ text: String) {
        tap()
        let current = (value as? String) ?? ""
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
    }
}
