import XCTest

/// Empty native views with no computer, network startup or real credentials.
@MainActor
final class PhoneSetupTests: XCTestCase {
    func testEmptyPhoneSurfaces() {
        for surface in ["Chats", "Computers", "Models"] {
            let app = launch(surface)
            if surface == "Computers" {
                let phone = app.buttons["computers.phone"]
                XCTAssertTrue(phone.waitForExistence(timeout: 5))
                XCTAssertTrue(phone.label.contains("This iPhone"))
                attach(app, "phone-setup-computers")
                phone.tap()
            } else {
                XCTAssertTrue(app.buttons["phoneSetup.connect"].waitForExistence(timeout: 5))
                attach(app, "phone-setup-\(surface.lowercased())")
            }
            let connect = app.buttons["phoneSetup.connect"]
            XCTAssertTrue(connect.waitForExistence(timeout: 5))
            XCTAssertTrue(connect.isHittable)
            connect.tap()
            XCTAssertTrue(app.secureTextFields["addPhoneProvider.key"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["addPhoneProvider.save"].isEnabled, "A key is required; opening setup saves nothing")
            attach(app, "phone-provider-editor-\(surface.lowercased())")
            app.buttons["Cancel"].tap()
            XCTAssertTrue(connect.waitForExistence(timeout: 5), "Cancel leaves the phone unconfigured")
            app.terminate()
        }
    }

    func testSetupFitsLargeTextAndDarkMode() {
        for extra in [["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"], ["-theme", "dark"]] {
            let app = launch("Models", extra: extra)
            let connect = app.buttons["phoneSetup.connect"]
            XCTAssertTrue(connect.waitForExistence(timeout: 5))
            if !connect.isHittable { app.swipeUp() }
            XCTAssertTrue(connect.isHittable)
            attach(app, extra.first == "-theme" ? "phone-setup-dark" : "phone-setup-large-text")
            connect.tap()
            XCTAssertTrue(app.secureTextFields["addPhoneProvider.key"].waitForExistence(timeout: 5))
            app.terminate()
        }
    }

    func testConfiguredPhoneDoesNotShowGettingStarted() {
        let app = launch("Models", extra: ["-uiTestPhoneProvider"])
        XCTAssertTrue(app.switches["phoneModels.provider"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["phoneSetup.connect"].exists)
        XCTAssertTrue(app.buttons["phoneModels.add"].exists)
        app.terminate()
    }

    private func launch(_ surface: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestPhoneSetup", "-phoneSetup\(surface)"] + extra
        app.launch()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10))
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
