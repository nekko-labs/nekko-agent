import XCTest

extension XCTestCase {
    /// The Chats view options are a Form in a popover with a minimum height, so
    /// controls near its end (Show, Done) can sit below the fold. Scroll the Form
    /// until `element` is fully inside the popover and hittable.
    @discardableResult
    func revealViewOption(_ element: XCUIElement, in app: XCUIApplication,
                          file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let popover = app.popovers.firstMatch
        let form = popover.collectionViews.firstMatch
        guard popover.waitForExistence(timeout: 3), form.exists else {
            XCTFail("View options exposes its scrollable Form", file: file, line: line)
            return false
        }
        for attempt in 0...4 {
            if element.exists, !element.frame.isEmpty,
               popover.frame.contains(element.frame), element.isHittable {
                return true
            }
            if attempt < 4 { form.swipeUp() }
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "view-option-not-reachable"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTFail("View option is not fully visible and hittable: \(element)", file: file, line: line)
        return false
    }

    /// Close the Chats view options with its Done button, scrolled into view first.
    func closeViewOptions(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let done = app.buttons["chats.view.done"]
        if revealViewOption(done, in: app, file: file, line: line) { done.tap() }
    }
}
