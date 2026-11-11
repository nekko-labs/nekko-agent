import XCTest

extension XCTestCase {
    /// The Chats view options are one native menu (#2449). Group by shows as a
    /// submenu row whose label carries its value, so match its identifier or label.
    func viewOptionsGroupBy(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label BEGINSWITH %@", "chats.view.groupBy", "Group by")).firstMatch
    }

    /// Open a submenu of the view options (Card details, Show) until `element` shows.
    @discardableResult
    func openViewOptionsSubmenu(_ name: String, showing element: XCUIElement, in app: XCUIApplication,
                                file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let row = app.buttons[name].firstMatch
        for _ in 0..<3 where !element.exists {
            if row.waitForExistence(timeout: 3) { row.tap() }
            _ = element.waitForExistence(timeout: 3)
        }
        if !element.exists { XCTFail("\(name) opens its choices", file: file, line: line) }
        return element.exists
    }

    /// Close the Chats view options: a tap outside the menu closes it without
    /// reaching the list behind (the menu has no Done button).
    func closeViewOptions(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        // A choice in Group by or Sort by closes the menu itself: let that finish first,
        // so the tap below never lands on the list.
        let settling = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: viewOptionsGroupBy(app))
        _ = XCTWaiter().wait(for: [settling], timeout: 1.5)
        guard viewOptionsGroupBy(app).exists || app.buttons["Show"].exists else { return }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)).tap()
        let closed = [viewOptionsGroupBy(app), app.buttons["Show"].firstMatch].map {
            XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: $0)
        }
        if XCTWaiter().wait(for: closed, timeout: 5) != .completed {
            XCTFail("a tap outside closes the view options", file: file, line: line)
        }
    }
}
