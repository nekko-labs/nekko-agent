import XCTest

/// One Claude login with a personal plan and an organization seat (#2488): the
/// model picker lists each account as its own group, named and with the email
/// and which account it is under it. Seeded offline, no pairing or network.
@MainActor
final class ClaudeAccountsTests: XCTestCase {
    func testEachClaudeAccountIsItsOwnGroup() {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestModelTabs", "-uiTestClaudeAccounts"]
        app.launch()
        let personal = app.descendants(matching: .any)["modelPicker.provider.personal"]
        let acme = app.descendants(matching: .any)["modelPicker.provider.acme"]
        XCTAssertTrue(personal.waitForExistence(timeout: 10))
        XCTAssertTrue(acme.exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "iphone-claude-accounts"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(personal.label.contains("Personal · Max"), personal.label)
        XCTAssertTrue(personal.label.contains("alex@example.test · Personal plan"), personal.label)
        XCTAssertTrue(acme.label.contains("Acme Inc · Team"), acme.label)
        XCTAssertTrue(acme.label.contains("alex@example.test · Organization"), acme.label)
    }
}
