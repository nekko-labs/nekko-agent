import XCTest

@MainActor
final class ChatRefreshTests: XCTestCase {
    func testChatEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.staticTexts["You are at the latest message."].waitForExistence(timeout: 15))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-header"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Opening a chat whose transcript comes in after the empty chat is laid out: its end
    /// shows at once, without the reader having to scroll for the rows to appear.
    func testALateTranscriptShowsItsEndWithoutScrolling() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-refreshLongChat", "-refreshSlowFirstRead",
                               "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        let latest = app.staticTexts["You are at the latest message."]
        XCTAssertTrue(latest.waitForExistence(timeout: 15), "the last row is built")
        // Past the settle after layout (under 0.2 s), with no touch from the test.
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertTrue(latest.isHittable, "the end of the transcript is on screen")
        let before = app.staticTexts["Message 29: let’s check the refresh at the end of this chat."]
        XCTAssertTrue(before.exists && before.isHittable, "the rows above the end are drawn too")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "late-transcript"
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testPullUpFromShortChatAndGreeting() {
        checkPull(long: false)
    }

    func testPullUpFromLongChatAndHistoryDoesNotRefresh() {
        checkPull(long: true)
    }

    private func checkPull(long: Bool) {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        if long { app.launchArguments.append("-refreshLongChat") }
        app.launch()
        let latest = app.staticTexts["You are at the latest message."]
        XCTAssertTrue(latest.waitForExistence(timeout: 15))
        let mascot = app.buttons["chats.mascot"]
        XCTAssertTrue(mascot.exists)
        XCTAssertLessThan(mascot.frame.maxX, app.staticTexts["Refresh from the latest"].frame.minX)
        XCTAssertGreaterThanOrEqual(mascot.frame.width, 44)
        mascot.tap()
        XCTAssertEqual(mascot.value as? String, "Hello!")
        XCTAssertTrue(waitValue(mascot, "Idle", timeout: 4))
        if long {
            app.swipeDown()
            XCTAssertEqual(mascot.value as? String, "Idle", "pulling down/history is not a refresh")
            app.swipeUp()
            // A fling to the end does not count: pull again from the settled end.
            if mascot.value as? String == "Refreshing" { XCTAssertTrue(waitValue(mascot, "Idle", timeout: 8)) }
        }
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        from.press(forDuration: 0.1, thenDragTo: to)
        XCTAssertTrue(waitValue(mascot, "Refreshing", timeout: 2), "upward bottom overscroll starts reload")
        let loading = XCTAttachment(screenshot: app.screenshot())
        loading.name = long ? "long-chat-loading" : "short-chat-loading"
        loading.lifetime = .keepAlways
        add(loading)
        XCTAssertTrue(waitValue(mascot, "Idle", timeout: 10))
        XCTAssertTrue(latest.isHittable, "the latest message remains visible after refresh")
    }

    func testShortPullDoesNotRefreshAndReducedMotionStillReloads() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-uiTestReduceMotion", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.staticTexts["You are at the latest message."].waitForExistence(timeout: 15))
        let mascot = app.buttons["chats.mascot"]
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        from.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.58)))
        XCTAssertEqual(mascot.value as? String, "Idle", "an insufficient bottom pull cancels")
        from.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)))
        XCTAssertTrue(waitValue(mascot, "Refreshing", timeout: 2))
        XCTAssertTrue(waitValue(mascot, "Idle", timeout: 10))
    }

    private func waitValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)], timeout: timeout) == .completed
    }

    func testListEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatStatus", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["chats.mascot"].waitForExistence(timeout: 10))
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "list-header"
        shot.lifetime = .keepAlways
        add(shot)
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.80))
        from.press(forDuration: 0.1, thenDragTo: to)
        Thread.sleep(forTimeInterval: 3)
    }
}
