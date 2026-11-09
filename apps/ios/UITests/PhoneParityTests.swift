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
        // Turning No restrictions on warns first (decision 0054).
        XCTAssertTrue(app.buttons["yoloWarning.confirm"].waitForExistence(timeout: 5))
        app.buttons["yoloWarning.confirm"].tap()
        XCTAssertEqual(app.buttons["newChat.tools"].value as? String, "No restrictions")
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
        // Shared before/after harness: the baseline has a menu item; View options
        // now exposes the same preference as an inline switch in its Show disclosure.
        let inlineAlways = app.switches["chats.view.showEmptyGroups"]
        let menuAlways = app.buttons["Always show groups"]
        // The Form is lazy: its first Show row is exposed before the lower
        // Always show groups row exists (native run 42578046165's AX tree).
        let previews = app.switches["Previews"]
        guard app.buttons["Show"].tapUntil(until: { previews.exists || menuAlways.exists }) else {
            XCTFail("Show exposes its controls")
            return
        }
        let usesInlineControls = previews.exists
        let always = usesInlineControls ? inlineAlways : menuAlways
        if usesInlineControls {
            guard revealViewOption(always, in: app) else { return }
        }
        XCTAssertTrue(always.waitForExistence(timeout: 3))
        attach(app, "groups-show-options")
        if usesInlineControls {
            // SwiftUI exposes a row-wide switch containing the actual control.
            // As in LiveRelayTests, tap the inner switch rather than the inert row.
            let knob = inlineAlways.switches.firstMatch
            let control = knob.exists ? knob : inlineAlways
            guard revealViewOption(control, in: app) else { return }
            control.tap()
        } else {
            always.tap()
        }
        if usesInlineControls {
            XCTAssertEqual(inlineAlways.value as? String, "1", "Always show groups is enabled")
            let done = app.buttons["chats.view.done"]
            guard revealViewOption(done, in: app) else { return }
            done.tap()
        }
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

    /// Form rows may exist in accessibility while clipped by the popover.
    /// Scroll that Form, not the chat list behind it, before tapping a control.
    private func revealViewOption(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        let popover = app.popovers.firstMatch
        let form = popover.collectionViews.firstMatch
        guard popover.waitForExistence(timeout: 3), form.exists else {
            XCTFail("View options exposes its scrollable Form")
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
        XCTFail("View option is not fully visible and hittable: \(element)")
        return false
    }

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-uiTestReset", "YES", "-theme", "dark", "-AppleLanguages", "(en)", "-expertMode", "NO",
                               "-skipYoloWarning", "NO", fixture] + extra
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
