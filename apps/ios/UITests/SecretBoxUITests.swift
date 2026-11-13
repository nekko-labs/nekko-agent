import XCTest

/// The chat's secret box when the agent asks for a secret (`-uiTestSecretBox`,
/// spec/chat/secrets-in-chat.md): a lock, the variable name and the reason, and
/// "Enter this on your computer" (the value is never entered on the phone). The box goes
/// away when the computer sends `secret_resolved`. Screenshot attachments in each theme.
@MainActor
final class SecretBoxUITests: XCTestCase {
    override func setUp() async throws { continueAfterFailure = false }

    func testTheBoxShowsTheRequestAndGoesWhenResolved() throws {
        for theme in uiTestThemes {
            let app = XCUIApplication()
            app.launchArguments = ["-uiTestSecretBox", "-secretResolveAfter", "9", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                                   "-theme", theme, "-AppleLanguages", "(en)", "-expertMode", "NO"]
            app.launch()
            let card = app.descendants(matching: .any)["chat.secretCard"]
            XCTAssertTrue(card.waitForExistence(timeout: 20), "the pending secret shows its box")
            XCTAssertTrue(app.staticTexts["OPENAI_API_KEY"].exists)
            XCTAssertTrue(app.staticTexts["Enter this on your computer"].exists)
            XCTAssertFalse(app.secureTextFields.firstMatch.exists, "the phone offers no field for a value")
            sleep(1)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "secret-box-\(theme)"
            shot.lifetime = .keepAlways
            add(shot)
            auditAccessibility(app, "secret-box-\(theme)")
            XCTAssertTrue(card.waitForNonExistence(timeout: 30), "secret_resolved takes the box away")
            app.terminate()
        }
    }
}
