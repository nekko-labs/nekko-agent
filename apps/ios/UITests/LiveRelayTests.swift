import XCTest

/// The app in the simulator against a real relay + headless agent + fake model
/// (apps/ios/scripts/itest-stack.sh): pair from a deep link, start a chat,
/// watch the reply stream in, get an approval card for a guarded tool and deny
/// it. Each step is a screenshot attachment (the PR's visual evidence).
///
/// Opt-in: the CI passes `TEST_RUNNER_NEKKO_ITEST_LINK`; without it this skips.
final class LiveRelayTests: XCTestCase {
    func testPairStreamAndApproveFromThePhone() throws {
        guard let raw = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"], let link = URL(string: raw) else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let theme = ProcessInfo.processInfo.environment["NEKKO_ITEST_THEME"] ?? "light"
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-theme", theme == "dark" ? "dark" : "light", "-uiTestReset", "YES"]
        app.launch()
        allowSystemAlerts()

        // Pair through the paste field (the deep link lands on the same code path,
        // but XCUITest's URL opening is unreliable for custom schemes).
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attach(app, "\(theme)-0-welcome")
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link.absoluteString)
        attach(app, "\(theme)-1-pair")
        app.buttons["Pair"].firstMatch.tap()
        tapSystemAlertIfShown()

        let newChat = app.navigationBars.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 20))
        XCTAssertTrue(waitEnabled(newChat, 20), "connected to the computer")
        attach(app, "\(theme)-2-chats")

        newChat.tap()
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 5))
        prompt.tap()
        prompt.typeText("Say hello")
        attach(app, "\(theme)-3-new-chat")
        app.buttons["Start"].tap()

        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: 30), "the reply streamed in")
        attach(app, "\(theme)-4-reply")

        let message = app.input("Message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        message.tap()
        message.typeText("please approve a cleanup")
        app.buttons["Send"].tap()
        let card = app.staticTexts["Approve this tool?"]
        XCTAssertTrue(card.waitForExistence(timeout: 30), "the guarded tool asks the phone")
        attach(app, "\(theme)-5-approval")
        app.buttons["Deny"].tap()
        XCTAssertTrue(waitGone(card, 15))
        attach(app, "\(theme)-6-denied")

        // The agent asks; the phone answers.
        message.tap()
        message.typeText("ask me which platform")
        app.buttons["Send"].tap()
        let question = app.staticTexts["Which platform should I build first?"]
        XCTAssertTrue(question.waitForExistence(timeout: 30), "the question reaches the phone")
        attach(app, "\(theme)-6b-question")
        app.buttons["iOS"].firstMatch.tap()
        app.buttons["Answer"].tap()
        XCTAssertTrue(waitGone(question, 15))
        XCTAssertTrue(app.staticTexts["Hello from your computer."].firstMatch.waitForExistence(timeout: 30))

        // A longer run, then Home: the Live Activity takes over in the Dynamic Island.
        message.tap()
        message.typeText("a slow one please")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "word2")).firstMatch.waitForExistence(timeout: 20))
        XCUIDevice.shared.press(.home)
        sleep(3)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let shot = XCTAttachment(screenshot: springboard.screenshot())
        shot.name = "\(theme)-6c-live-activity"
        shot.lifetime = .keepAlways
        add(shot)
        app.activate()

        app.navigationBars.buttons.element(boundBy: 0).tap()
        attach(app, "\(theme)-7-chats-after")
    }

    private func allowSystemAlerts() {
        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for label in ["Allow", "OK", "Allow While Using App"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    /// Notification permission is asked right after pairing.
    private func tapSystemAlertIfShown() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
    }

    private func waitEnabled(_ e: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let p = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: e)
        return XCTWaiter.wait(for: [p], timeout: seconds) == .completed
    }

    private func waitGone(_ e: XCUIElement, _ seconds: TimeInterval) -> Bool {
        let p = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: e)
        return XCTWaiter.wait(for: [p], timeout: seconds) == .completed
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
