import XCTest

final class ComputersTests: XCTestCase {
    /// A paired computer can be renamed and forgotten from a tap on its row in
    /// Computers, and forgotten from the computer menu on the chats screen.
    func testRenameAndForgetAComputer() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()

        pair(app)
        menu(app).tap()
        app.buttons["Computers"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "relay.example.com")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))

        row.tap()
        app.buttons["Rename"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.clearAndType("Studio")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Studio"].waitForExistence(timeout: 5), "Rename saved")

        row.tap()
        app.buttons["Forget…"].tap()
        confirmForget(app)
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "Forget from a tap removed the computer")

        // From the computer menu on the chats screen.
        app.terminate()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        pair(app)
        menu(app).tap()
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
    }

    private func menu(_ app: XCUIApplication) -> XCUIElement {
        let m = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers and settings")).firstMatch
        XCTAssertTrue(m.waitForExistence(timeout: 10))
        return m
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
