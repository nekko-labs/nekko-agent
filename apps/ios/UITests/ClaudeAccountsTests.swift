import XCTest

/// One Claude login with a personal plan and an organization seat (#2488): the
/// model picker shows both under one Claude group with the desktop's account
/// slider, the email and which account it is under it, and only the account on
/// show's models. Seeded offline, no pairing or network.
@MainActor
final class ClaudeAccountsTests: XCTestCase {
    func testClaudeAccountsShareOneSlider() {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestModelTabs", "-uiTestClaudeAccounts"]
        app.launch()
        let slider = app.segmentedControls["modelPicker.accounts"]
        XCTAssertTrue(slider.waitForExistence(timeout: 10))
        XCTAssertTrue(slider.buttons["Personal · Max"].isSelected)
        XCTAssertTrue(slider.buttons["Acme Inc · Team"].exists)
        // Opens on the account the pick is on.
        let personal = app.staticTexts["modelPicker.account.personal"]
        XCTAssertTrue(personal.exists)
        XCTAssertEqual(personal.label, "alex@example.test · Personal plan")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "iphone-claude-accounts"
        shot.lifetime = .keepAlways
        add(shot)

        slider.buttons["Acme Inc · Team"].tap()
        let acme = app.staticTexts["modelPicker.account.acme"]
        XCTAssertTrue(acme.waitForExistence(timeout: 5))
        XCTAssertEqual(acme.label, "alex@example.test · Organization")
        XCTAssertFalse(personal.exists)
        let after = XCTAttachment(screenshot: app.screenshot())
        after.name = "iphone-claude-accounts-acme"
        after.lifetime = .keepAlways
        add(after)
    }
}
