import XCTest

/// Before/after evidence for #2451: icons in the theme's colours, never the system blue.
/// The same harness runs on the baseline and the change (native-mode-evidence.yml).
@MainActor
final class IconThemeEvidenceTests: XCTestCase {
    /// The chat list's status glyphs and group headings, in each kind of theme.
    func testStatusGlyphsEvidence() {
        for theme in ["light", "dark", "autumn", "x-indigo-white"] {
            let app = XCUIApplication()
            app.launchArguments = ["-uiTestChatStatus", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                                   "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", theme]
            app.launch()
            XCTAssertTrue(app.buttons["chats.mascot"].waitForExistence(timeout: 10))
            attach(app, "icons-status-\(theme)")
            app.terminate()
        }
    }

    /// View options (one native menu, #2449) and Settings rows, light and dark.
    func testTintAndRowIconsEvidence() {
        for theme in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-splash", "NO",
                                   "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", theme, "-expertMode", "YES"]
            app.launch()
            pair(app)
            let view = app.buttons["chats.view"]
            XCTAssertTrue(view.waitForExistence(timeout: 10))
            attach(app, "icons-chats-\(theme)")
            view.tap()
            XCTAssertTrue(viewOptionsGroupBy(app).waitForExistence(timeout: 5))
            attach(app, "icons-view-options-\(theme)")
            closeViewOptions(app)
            openSettings(app)
            attach(app, "icons-settings-\(theme)")
            app.swipeUp()
            attach(app, "icons-settings-more-\(theme)")
            app.terminate()
        }
    }

    private func pair(_ app: XCUIApplication) {
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("relay=wss://relay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff&host=BJ7go4GGB9flqEQfjn77eO%2BWT5J%2Bxi8WJkMUlZycp%2BJNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE%3D")
        app.buttons["Pair"].firstMatch.tap()
        if app.buttons["Not now"].waitForExistence(timeout: 3) { app.buttons["Not now"].tap() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 2) { springboard.buttons["Allow"].tap() }
    }

    /// The computer menu by coordinate once it has a real frame (see ThemeLanguageTests).
    private func openSettings(_ app: XCUIApplication) {
        let menu = app.buttons["chats.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let f = menu.frame
            if menu.exists, !f.isEmpty, app.frame.contains(CGPoint(x: f.midX, y: f.midY)) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Settings"].firstMatch.tapUntil { app.buttons["settings.theme"].exists }, "the menu opens Settings")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
