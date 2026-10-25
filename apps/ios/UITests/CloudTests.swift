import XCTest

/// Nekko Cloud's sign-in screen, reached from the welcome screen, in light and
/// dark (the screenshots are the PR's iPhone evidence), audited for accessibility.
final class CloudTests: XCTestCase {
    func testTheSignInScreenInLightAndDark() {
        for theme in uiTestThemes {
            let app = XCUIApplication()
            // No Nekko Cloud reachable: the screen renders without the network.
            app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-theme", theme, "-uiTestReset", "YES", "-cloudAPI", "http://127.0.0.1:9"]
            app.launch()
            let link = app.buttons["welcome.cloud"]
            XCTAssertTrue(link.waitForExistence(timeout: 10))
            link.tap()
            XCTAssertTrue(app.staticTexts["Sign in to Nekko Cloud"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["Continue with Apple"].exists)
            attach(app, "Cloud sign-in (\(theme))")
            if theme == "light" { auditAccessibility(app, "cloud-sign-in") }
            let email = app.textFields["cloud.email"]
            email.tap()
            email.typeText("ada@example.com")
            app.buttons["cloud.sendCode"].tap()
            // The dev URL answers nothing, so the error shows under the form.
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "connect")).firstMatch.waitForExistence(timeout: 20))
            app.terminate()
        }
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
