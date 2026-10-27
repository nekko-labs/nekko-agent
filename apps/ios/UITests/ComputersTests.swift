import XCTest

final class ComputersTests: XCTestCase {
    /// A paired computer can be renamed and forgotten from its page (a tap on
    /// its row in Computers opens it, Edit holds both), and forgotten from the
    /// computer menu on the chats screen.
    func testRenameAndForgetAComputer() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()

        pair(app)
        openMenu(app)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "relay.example.com")).firstMatch
        XCTAssertTrue(app.buttons["Computers"].tapUntil { row.exists }, "the menu opens Computers")

        // The row opens the computer's page; Rename and Forget live in its Edit menu.
        row.tap()
        let edit = app.buttons["computer.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5), "the computer's page")
        tapBarButton(edit, in: app)
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(app.buttons["Rename"].tapUntil { name.exists }, "Edit offers Rename")
        name.clearAndType("Studio")
        app.alerts.buttons["Save"].tap()
        let renamed = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Studio")).firstMatch
        XCTAssertTrue(renamed.waitForExistence(timeout: 5), "Rename saved")

        tapBarButton(edit, in: app)
        XCTAssertTrue(app.buttons["Forget…"].tapUntil { app.buttons.matching(NSPredicate(format: "label == %@", "Forget")).firstMatch.exists }, "Edit offers Forget")
        confirmForget(app)
        // Forgetting the only computer leaves the app with nothing paired: the
        // page either says so or the stack unwinds to the pairing invitation.
        let gone = app.buttons["Pair with your computer"].waitForExistence(timeout: 10)
            || app.staticTexts["This computer was forgotten"].exists
        XCTAssertTrue(gone, "Forget from the computer page removed the only computer")

        // From the computer menu on the chats screen.
        app.terminate()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        pair(app)
        openMenu(app)
        let computer = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "computer")).element(boundBy: 0)
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        XCTAssertTrue(computer.tapUntil { app.buttons["Forget…"].exists }, "the computer opens its submenu")
        XCTAssertTrue(app.buttons["Forget…"].tapUntil { app.buttons.matching(NSPredicate(format: "label == %@", "Forget")).firstMatch.exists }, "the computer's submenu offers Forget")
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

    /// The same for any navigation bar button, such as the computer page's Edit
    /// menu, which XCTest also fails to "scroll to visible".
    private func tapBarButton(_ button: XCUIElement, in app: XCUIApplication) {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let f = button.frame
            if button.exists, !f.isEmpty, app.frame.contains(CGPoint(x: f.midX, y: f.midY)) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
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
