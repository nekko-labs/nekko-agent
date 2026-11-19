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

    /// The Add sheet for a key-page kind (Claude API) and the sign-in kind (OpenRouter).
    func testProviderSetupEvidence() {
        for theme in ["light", "dark"] {
            let chat = launch("-uiTestPhoneComposer", theme: theme)
            XCTAssertTrue(chat.buttons["phoneChat.model"].waitForExistence(timeout: 10))
            chat.buttons["phoneChat.model"].tap()
            let add = chat.buttons["phoneModel.addProvider"]
            XCTAssertTrue(add.waitForExistence(timeout: 5))
            add.tap()
            XCTAssertTrue(chat.buttons["addPhoneProvider.save"].waitForExistence(timeout: 5))
            attach(chat, "\(theme)-provider-claude")
            chat.buttons["addPhoneProvider.kind"].firstMatch.tap()
            let openRouter = chat.buttons["OpenRouter"].firstMatch
            if openRouter.waitForExistence(timeout: 3) {
                openRouter.tap()
                _ = chat.buttons["addPhoneProvider.signIn"].waitForExistence(timeout: 3)
                attach(chat, "\(theme)-provider-openrouter")
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
        XCTAssertFalse(app.descendants(matching: .any)["newChat.phoneNote"].exists, "no \"no tools\" note under the composer")
        XCTAssertTrue(app.buttons["newChat.computer"].label.contains("This iPhone"))
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

    /// New chat’s connect checklist (#2921): over the first message with nothing connected, then closed and undone.
    func testConnectChecklistOnTheFirstMessage() {
        let app = launch("-uiTestPhoneProvider", theme: "dark", extra: ["-connectChecklistClosed", "NO", "-firstMessageSent", "NO"])
        let newChat = app.navigationBars.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 10))
        newChat.tap()
        let checklist = app.descendants(matching: .any)["connectChecklist"]
        XCTAssertTrue(checklist.waitForExistence(timeout: 5), "the checklist over the first message")
        for row in ["computer", "folder", "git", "tasks"] {
            XCTAssertTrue(app.buttons["connectChecklist.\(row)"].exists, row)
        }
        attach(app, "connect-checklist-first-message")
        app.buttons["connectChecklist.close"].tap()
        let undo = app.buttons["connectChecklist.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 3), "Undo where the checklist was")
        undo.tap()
        XCTAssertTrue(checklist.waitForExistence(timeout: 3), "Undo brings it back")
        app.terminate()
    }

    private func launch(_ fixture: String, theme: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-theme", theme, "-AppleLanguages", "(en)", fixture] + extra
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
