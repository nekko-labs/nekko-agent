import XCTest

final class ChatStatusTests: XCTestCase {
    func testStatusShapesAndMascotGreeting() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatStatus", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "light"]
        app.launch()
        let mascot = app.buttons["chats.mascot"]
        XCTAssertTrue(mascot.waitForExistence(timeout: 10))
        XCTAssertEqual(mascot.value as? String, "Working")
        XCTAssertGreaterThanOrEqual(mascot.frame.width, 44)
        XCTAssertGreaterThanOrEqual(mascot.frame.height, 44)
        let before = XCTAttachment(screenshot: app.screenshot())
        before.name = "chat-status-after"
        before.lifetime = .keepAlways
        add(before)
        mascot.tap()
        XCTAssertEqual(mascot.value as? String, "Hello!")
        let greeting = XCTAttachment(screenshot: app.screenshot())
        greeting.name = "mascot-greeting"
        greeting.lifetime = .keepAlways
        add(greeting)
        let returned = NSPredicate(format: "value == %@", "Working")
        expectation(for: returned, evaluatedWith: mascot)
        waitForExpectations(timeout: 4)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Idle")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Done")).firstMatch.exists)
    }
}
