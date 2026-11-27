import XCTest

/// Search chats finds a phrase said in the middle of a chat, with the line it was said in (#3448),
/// and a computer without `sessions:finderText` keeps the summary search. The same cases as
/// Android's ChatSearchMessagesDeviceTest; screenshots `chat-search-*`.
@MainActor
final class ChatSearchMessagesTests: XCTestCase {
    private func launch(older: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "light", "-AppleLanguages", "(en)", "-uiTestChatSearch"] + (older ? ["-uiTestChatSearchOlder"] : [])
        app.terminate()
        app.launch()
        return app
    }

    private func search(_ app: XCUIApplication, _ text: String) {
        // Both chats sit in the Done group, folded until a search opens it.
        XCTAssertTrue(app.buttons["chats.group.status:done"].waitForExistence(timeout: 15), "the chats")
        let menu = app.buttons["chats.menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let field = app.textFields["chats.search"]
        XCTAssertTrue(app.buttons["chats.menu.search"].firstMatch.tapUntil { field.exists }, "the menu opens the search")
        field.tap()
        field.typeText(text)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-search-\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testFindsAPhraseSaidMidChatWithItsLine() {
        let app = launch(older: false)
        search(app, "runner image")
        let snippet = app.staticTexts.matching(identifier: "chats.row.snippet").firstMatch
        XCTAssertTrue(snippet.waitForExistence(timeout: 10), "the line that matched shows under the row")
        XCTAssertTrue(snippet.label.contains("The key includes the runner image date"), snippet.label)
        XCTAssertTrue(app.staticTexts["Speed up the CI cache"].exists)
        XCTAssertFalse(app.staticTexts["Plan the week"].exists)
        attach(app, "found-in-messages")
    }

    func testAnOlderComputerKeepsTheSummarySearch() {
        let app = launch(older: true)
        search(app, "runner image")
        XCTAssertTrue(app.staticTexts["No chats match “runner image”."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(identifier: "chats.row.snippet").firstMatch.exists)
        attach(app, "older-computer-summaries-only")
    }
}
