import XCTest

/// The desktop's themes and languages on the iPhone: Settings offers every
/// desktop preset and a Language row, and the app runs in Japanese.
@MainActor
final class ThemeLanguageTests: XCTestCase {
    func testPicksADesktopThemeFromSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-splash", "NO", "-AppleLanguages", "(en)", "-theme", "computer"]
        app.launch()
        pair(app, pairButton: "Pair with your computer", pair: "Pair", notNow: "Not now")
        openSettings(app, settings: "Settings")

        let theme = app.buttons["settings.theme"]
        XCTAssertTrue(theme.waitForExistence(timeout: 5), "Settings → Theme")
        XCTAssertTrue(app.buttons["settings.language"].exists, "Settings → Language")
        attach(app, "en-settings-appearance")
        theme.tap()
        for name in ["Match my computer", "Nebula", "Terminal", "Nord", "Solar", "Ember", "Spooky"] {
            XCTAssertTrue(app.buttons[name].waitForExistence(timeout: 3), name)
        }
        attach(app, "en-theme-picker")
        app.buttons["Spooky"].tap()
        // In October iOS confirms the Spooky icon with an alert of its own.
        let ok = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["OK"]
        if ok.waitForExistence(timeout: 3) {
            attach(app, "en-spooky-icon")
            ok.tap()
        }
        XCTAssertTrue(theme.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Spooky"].waitForExistence(timeout: 3), "the picked theme shows on the row")
        attach(app, "en-settings-spooky")
    }

    /// The same harness runs over base and head without assuming either mode's display name.
    func testSimpleModeLabelEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-splash", "NO",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", "light", "-expertMode", "NO"]
        app.launch()
        pair(app, pairButton: "Pair with your computer", pair: "Pair", notNow: "Not now")
        openSettings(app, settings: "Settings")
        let simpleMode = app.buttons["settings.simpleMode"]
        for _ in 0..<6 {
            if simpleMode.exists && simpleMode.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(simpleMode.waitForExistence(timeout: 5), "Settings offers Simple mode")
        attach(app, "mode-label-settings")
        simpleMode.tap()
        let preview = app.segmentedControls["simpleMode.preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 5), "Settings opens Simple mode")
        XCTAssertEqual(preview.buttons.count, 2, "both preview modes are present")
        attach(app, "mode-label-simple-preview")
        // Stable identifier and segment position, not Expert/Detailed text.
        preview.buttons.element(boundBy: 1).tap()
        XCTAssertTrue(preview.buttons.element(boundBy: 1).isSelected)
        attach(app, "mode-label-full-preview")
    }

    /// The same harness runs on baseline and head. Customize is new, so has no before state.
    func testCustomizeEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-splash", "NO",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", "dark", "-expertMode", "NO"]
        app.launch()
        pair(app, pairButton: "Pair with your computer", pair: "Pair", notNow: "Not now")
        let view = app.buttons["chats.view"]
        XCTAssertTrue(view.waitForExistence(timeout: 10))
        view.tap()
        attach(app, "customize-view-options")
        // Simple / Detailed is the compact row atop the view menu (#2449); reopen the menu if the pick closed it.
        let detailed = app.buttons["Detailed"].firstMatch
        if detailed.waitForExistence(timeout: 5) {
            detailed.tap()
            let customize = app.buttons["Customize…"].firstMatch
            if !customize.waitForExistence(timeout: 2) { view.tap() }
            XCTAssertTrue(customize.waitForExistence(timeout: 5), "the view menu offers Customize…")
            attach(app, "customize-view-options-detailed")
            customize.tap()
            XCTAssertTrue(app.buttons["customize.Experience"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["settings.theme"].waitForExistence(timeout: 5), "Customize reuses the existing theme picker")
            attach(app, "customize-experience")
            app.buttons["customize.Connectors"].tap()
            attach(app, "customize-connectors")
            app.buttons["customize.Skills"].tap()
            attach(app, "customize-skills")
        }
        app.terminate()
    }

    /// Same real chat fixture on both app revisions, with no paired computer or network.
    func testLightPaletteEvidence() {
        for preset in ["x-plum-white", "x-indigo-white", "x-plum-dark", "x-indigo-dark"] {
            let app = XCUIApplication()
            app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                                   "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", preset, "-uiTestMarkdownLab"]
            app.launch()
            XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 15), "the real reply is drawn")
            attach(app, "light-themes-\(preset)")
            app.terminate()
        }
    }

    func testRunsInJapanese() {
        let app = XCUIApplication()
        app.launchArguments = ["-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES", "-splash", "NO",
                               "-AppleLanguages", "(ja)", "-theme", "autumn"]
        app.launch()
        XCTAssertTrue(app.buttons["コンピュータとペアリング"].waitForExistence(timeout: 10), "the first screen in Japanese")
        attach(app, "ja-first-run")
        pair(app, pairButton: "コンピュータとペアリング", pair: "ペアリング", notNow: "今はしない")
        openSettings(app, settings: "設定")
        XCTAssertTrue(app.buttons["settings.theme"].waitForExistence(timeout: 5))
        attach(app, "ja-settings")
    }

    private func pair(_ app: XCUIApplication, pairButton: String, pair: String, notNow: String) {
        let start = app.buttons[pairButton]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("relay=wss://relay.example.com&room=a1b2c3d4e5f60718&key=00112233445566778899aabbccddeeff&host=BJ7go4GGB9flqEQfjn77eO%2BWT5J%2Bxi8WJkMUlZycp%2BJNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE%3D")
        app.buttons[pair].firstMatch.tap()
        if app.buttons[notNow].waitForExistence(timeout: 3) { app.buttons[notNow].tap() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for allow in ["Allow", "許可"] where springboard.buttons[allow].waitForExistence(timeout: 2) {
            springboard.buttons[allow].tap()
        }
    }

    /// The computer menu by coordinate once it has a real frame (see ComputersTests.openMenu).
    private func openSettings(_ app: XCUIApplication, settings: String) {
        let m = app.buttons["chats.menu"]
        XCTAssertTrue(m.waitForExistence(timeout: 10))
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let f = m.frame
            if m.exists, !f.isEmpty, app.frame.contains(CGPoint(x: f.midX, y: f.midY)) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        m.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons[settings].firstMatch.tapUntil { app.buttons["settings.theme"].exists }, "the menu opens Settings")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
