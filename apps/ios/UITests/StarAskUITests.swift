import XCTest

/// The GitHub star ask under the 10th reply (`-uiTestStarAsk`, spec/platform/github-star-ask.md):
/// nine prompts are already counted, so the next reply carries the card. The card is
/// a screenshot attachment in each theme.
@MainActor
final class StarAskUITests: XCTestCase {
    override func setUp() async throws { continueAfterFailure = false }

    func testTheTenthReplyAsksAndTheNextSendRemovesIt() throws {
        for theme in uiTestThemes {
            let app = launch(theme: theme)
            sendDraft(app)
            let card = app.descendants(matching: .any)["starAsk.card"]
            XCTAssertTrue(card.waitForExistence(timeout: 15), "the 10th reply carries the card")
            XCTAssertTrue(app.staticTexts["Nekko Agent is open source"].exists)
            XCTAssertTrue(app.staticTexts["If it helps you, a star on GitHub helps more people find it."].exists)
            XCTAssertTrue(app.buttons["starAsk.star"].exists)
            XCTAssertTrue(app.buttons["starAsk.later"].exists)
            XCTAssertTrue(app.buttons["starAsk.never"].exists)
            sleep(1)
            attach(app, "star-ask-\(theme)")
            auditAccessibility(app, "star-ask-\(theme)")

            // Sending again without choosing takes it away (Not now), and the 11th reply carries none.
            send(app, "And the changelog?")
            XCTAssertTrue(app.staticTexts["Reply 3: done, nothing else needs you."].waitForExistence(timeout: 15))
            XCTAssertTrue(card.waitForNonExistence(timeout: 5), "the next send removes the card")
            sleep(1)
            XCTAssertFalse(card.exists, "the 11th reply asks nothing")
            app.terminate()
        }
    }

    func testNotNowAndDontAskAgainClose() throws {
        for button in ["starAsk.later", "starAsk.never"] {
            let app = launch(theme: "light")
            sendDraft(app)
            let card = app.descendants(matching: .any)["starAsk.card"]
            XCTAssertTrue(card.waitForExistence(timeout: 15))
            app.buttons[button].tap()
            XCTAssertTrue(card.waitForNonExistence(timeout: 5), "\(button) closes the card")
            app.terminate()
        }
    }

    func testStarOpensGitHubAndThanks() throws {
        let app = launch(theme: "light")
        sendDraft(app)
        let card = app.descendants(matching: .any)["starAsk.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        app.buttons["starAsk.star"].tap()
        // GitHub opens in the browser; coming back, the card says thank you.
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        _ = safari.wait(for: .runningForeground, timeout: 15)
        app.activate()
        XCTAssertTrue(app.staticTexts["Thank you! Nekko is happy you’re here."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["starAsk.star"].exists, "nothing more to choose")
        attach(app, "star-ask-thanks-light")
        app.buttons["starAsk.close"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 5))
        app.terminate()
    }

    private func launch(theme: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestStarAsk", "-starAskPrompts", "9", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", theme, "-AppleLanguages", "(en)", "-expertMode", "NO"]
        app.launch()
        return app
    }

    /// Sends the prompt the fixture left in the box, and waits for its reply.
    private func sendDraft(_ app: XCUIApplication) {
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 20))
        send.tap()
        XCTAssertTrue(app.staticTexts["Reply 2: done, nothing else needs you."].waitForExistence(timeout: 15))
    }

    private func send(_ app: XCUIApplication, _ text: String) {
        let message = app.input("chat.message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        message.tap()
        message.typeText(text)
        app.buttons["Send"].tap()
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
