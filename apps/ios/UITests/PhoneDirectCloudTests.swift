import XCTest

/// Same harness on the unchanged base and feature revisions. All traffic uses
/// in-memory fixtures; no pairing, real credentials, microphone or paid API.
@MainActor
final class PhoneDirectCloudTests: XCTestCase {
    func testMatchedSetupEvidence() {
        for theme in ["light", "dark"] {
            let app = launch("-uiTestNewChat", theme: theme)
            XCTAssertTrue(app.textViews["newChat.prompt"].waitForExistence(timeout: 10))
            attach(app, "\(theme)-direct-new-chat")
            app.terminate()
            let chat = launch("-uiTestPhoneComposer", theme: theme)
            XCTAssertTrue(chat.buttons["phoneChat.model"].waitForExistence(timeout: 10))
            chat.buttons["phoneChat.model"].tap()
            XCTAssertTrue(chat.navigationBars["Model"].waitForExistence(timeout: 5))
            attach(chat, "\(theme)-direct-empty-model-picker")
            // Present only after implementation. The same before harness still
            // captures the original empty picker, not an invented before state.
            let add = chat.buttons["phoneModel.addProvider"]
            if add.exists {
                add.tap()
                XCTAssertTrue(chat.buttons["addPhoneProvider.save"].waitForExistence(timeout: 5))
                attach(chat, "\(theme)-direct-provider-form")
                chat.buttons["Cancel"].firstMatch.tap()
                XCTAssertTrue(add.waitForExistence(timeout: 5))
            }
            chat.terminate()
        }
    }

    func testDirectTextChatWithoutComputer() {
        let app = launch("-uiTestPhoneProvider", theme: "light")
        let newChat = app.navigationBars.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 10))
        newChat.tap()
        let prompt = app.textViews["newChat.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["newChat.phoneNote"].exists)
        prompt.tap()
        prompt.typeText("Hello without a computer")
        let start = app.buttons["newChat.start"]
        XCTAssertTrue(start.isEnabled)
        start.tap()
        XCTAssertTrue(app.staticTexts["Hello from this iPhone."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["phoneChat.place"].exists)
        attach(app, "direct-text-reply-no-computer")
        app.terminate()
    }

    private func launch(_ fixture: String, theme: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-theme", theme, "-AppleLanguages", "(en)", fixture]
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
