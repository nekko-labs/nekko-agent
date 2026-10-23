import XCTest

final class ComputersTests: XCTestCase {
    /// Forget and Rename act on the computer they were opened for. Both used to read
    /// state the dialog had already cleared on dismissal, so the tap did nothing.
    func testForgetAndRenameAComputer() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES"]
        app.launch()
        app.buttons["Pair with your computer"].tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("relay=wss://relay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff")
        app.buttons["Pair"].tap()
        if app.buttons["Not now"].waitForExistence(timeout: 3) { app.buttons["Not now"].tap() }

        let menu = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Computers and settings")).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        app.buttons["Computers"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "relay.example.com")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))

        row.swipeLeft()
        app.buttons["Rename"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.clearAndType("Studio")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Studio"].waitForExistence(timeout: 5), "Rename saved")

        row.swipeLeft()
        app.buttons["Forget"].firstMatch.tap()
        let confirm = app.sheets.buttons["Forget"].exists ? app.sheets.buttons["Forget"] : app.buttons.matching(identifier: "Forget").element(boundBy: 1)
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 5), "Forget removed the computer")
    }
}

private extension XCUIElement {
    func clearAndType(_ text: String) {
        tap()
        let current = (value as? String) ?? ""
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
    }
}
