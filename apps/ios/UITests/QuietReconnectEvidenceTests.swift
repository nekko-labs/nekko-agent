import XCTest

/// Overlay unchanged on base and head. The test opens the real Chat and New Chat surfaces
/// against a memory-only reconnecting computer, then holds New Chat for the dot recording.
@MainActor
final class QuietReconnectEvidenceTests: XCTestCase {
    func testChatAndNewChatEvidence() {
        let chat = launch()
        let saved = chat.descendants(matching: .any)["chat.savedCopy"].firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 15), "Real ChatView must show the seeded saved transcript")
        XCTAssertTrue(chat.staticTexts["Check the tests and review the release notes."].exists)
        let composer = chat.descendants(matching: .any)["chat.offlineNote"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "Real Composer must show its reconnect notice")
        XCTAssertFalse(saved.label.isEmpty)
        XCTAssertFalse(composer.label.isEmpty)
        XCTAssertNotNil(saved.label.range(of: "[0-9]", options: .regularExpression))
        attach(chat, "quiet-reconnect-chat")
        chat.terminate()

        let newChat = launch(extra: ["-quietReconnectNewChat"])
        let notice = newChat.descendants(matching: .any)["newChat.offlineNote"].firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 15), "Real NewChatView must show ReconnectingNotice")
        XCTAssertTrue(newChat.descendants(matching: .any)["reconnect.title"].firstMatch.exists)
        XCTAssertTrue(newChat.descendants(matching: .any)["newChat.start"].firstMatch.waitForExistence(timeout: 10))
        attach(newChat, "quiet-reconnect-new-chat")
        sleep(4)
        XCTAssertTrue(notice.exists, "The reconnecting state must remain steady throughout the recording")
        newChat.terminate()
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-uiTestQuietReconnectEvidence", "-splash", "NO", "-appLock", "NO",
            "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ] + extra
        app.launchEnvironment["TZ"] = "UTC"
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
