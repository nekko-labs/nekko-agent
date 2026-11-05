import XCTest

@MainActor
final class PhoneParityTests: XCTestCase {
    func testStarredSupportingFoldersStayInDraftWhileOffline() {
        let app = launch("-uiTestNewChat", extra: ["-uiTestStarredDraft"])
        let start = app.buttons["newChat.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertFalse(start.isEnabled)
        XCTAssertEqual(start.label, "Connect to start")
        XCTAssertEqual(app.textViews["newChat.prompt"].value as? String, "Review both folders")
        attach(app, "offline-starred-folders")
    }

    func testNewChatMarkdownVoiceAndPolicy() {
        let app = launch("-uiTestNewChat")
        let field = app.textViews["newChat.prompt"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["composer.voiceConversation"].exists)
        XCTAssertFalse(app.buttons["composer.dictate"].exists, "one mic: dictation is the keyboard's")
        attach(app, "new-chat-after")
        field.tap()
        field.typeText("**Bold** and _italic_\n- First item")
        XCTAssertTrue((field.value as? String)?.contains("**Bold**") == true)
        XCTAssertTrue(app.buttons["composer.bold"].exists)
        attach(app, "new-chat-markdown-keyboard")
        app.buttons["newChat.tools"].tap()
        XCTAssertTrue(app.buttons["tools.guardrails"].waitForExistence(timeout: 3))
        attach(app, "policy-keyboard-after")
        app.buttons["tools.yolo"].tap()
        XCTAssertEqual(app.buttons["newChat.tools"].value as? String, "Works on its own")
        XCTAssertTrue((field.value as? String)?.contains("**Bold**") == true)
    }

    func testHandsFreeCycleAndEndWithSilentFixture() {
        let app = launch("-uiTestVoiceConversation")
        XCTAssertTrue(app.staticTexts["Thinking"].waitForExistence(timeout: 8))
        attach(app, "hands-free-thinking-fixture")
        XCTAssertTrue(app.staticTexts["Speaking"].waitForExistence(timeout: 5))
        attach(app, "hands-free-speaking-fixture")
        app.buttons["voiceConversation.stop"].tap()
        XCTAssertTrue(app.staticTexts["Stopped"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["voiceConversation.start"].exists)
        attach(app, "hands-free-stopped-fixture")
    }

    func testHandsFreeBackgroundStopsSilentFixture() {
        let app = launch("-uiTestVoiceConversation")
        XCTAssertTrue(app.staticTexts["Speaking"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Stopped"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["voiceConversation.start"].exists)
        attach(app, "hands-free-after-background-fixture")
    }

    func testHandsFreeOpensWithoutListeningOrSending() {
        let app = launch("-uiTestPhoneComposer")
        let voice = app.buttons["composer.voiceConversation"]
        XCTAssertTrue(voice.waitForExistence(timeout: 10))
        voice.tap()
        XCTAssertTrue(app.buttons["voiceConversation.start"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready"].exists)
        XCTAssertFalse(app.buttons["voiceConversation.stop"].exists)
        attach(app, "hands-free-ready")
        app.buttons["Done"].tap()
        XCTAssertTrue(voice.waitForExistence(timeout: 3))
    }

    func testPhoneOnlyMarkdownAndVoice() {
        let app = launch("-uiTestPhoneComposer")
        let field = app.textViews["phoneChat.prompt"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["composer.voiceConversation"].exists)
        XCTAssertFalse(app.buttons["composer.dictate"].exists, "one mic: dictation is the keyboard's")
        attach(app, "phone-only-after")
        field.tap()
        field.typeText("**Draft** with a list\n- Item")
        XCTAssertTrue(app.buttons["composer.bold"].exists)
        XCTAssertTrue(app.buttons["phoneChat.send"].isEnabled)
        attach(app, "phone-only-keyboard-after")
    }

    func testGroupsAndFolderManagement() { checkGroups(reduced: false) }
    func testGroupsWithReducedMotion() { checkGroups(reduced: true) }

    private func checkGroups(reduced: Bool) {
        let app = launch("-uiTestPhoneParity", extra: reduced ? ["-uiTestReduceMotion"] : [])
        XCTAssertTrue(app.staticTexts["Building"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Verifying"].exists)
        attach(app, reduced ? "groups-reduced-before-move" : "groups-after")
        app.buttons["Advance agent"].tap()
        XCTAssertTrue(app.staticTexts["Verifying"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Building"].exists)
        attach(app, reduced ? "groups-reduced-after-move" : "groups-verifying")
        app.buttons["Advance agent"].tap()
        XCTAssertTrue(app.staticTexts["Watching"].waitForExistence(timeout: 3))
        attach(app, "groups-watching")
        app.buttons["View options"].tap()
        app.buttons["Show"].tap()
        let always = app.buttons["Always show groups"]
        XCTAssertTrue(always.waitForExistence(timeout: 3))
        always.tap()
        XCTAssertTrue(app.staticTexts["Building"].waitForExistence(timeout: 3))
        attach(app, "groups-always-visible")
        app.buttons["Folders"].tap()
        XCTAssertTrue(app.buttons["files.addFolder"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["files.star.app"].exists)
        attach(app, "folders-after")
        app.buttons["Manage App"].tap()
        XCTAssertTrue(app.buttons["Remove saved folder"].waitForExistence(timeout: 3))
        attach(app, "folders-remove-menu")
    }

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-uiTestReset", "YES", "-theme", "dark", "-AppleLanguages", "(en)", "-expertMode", "NO", fixture] + extra
        app.terminate()
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
