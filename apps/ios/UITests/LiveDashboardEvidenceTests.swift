import XCTest

/// Overlay this test unchanged on base and head using native-mode-evidence.yml.
/// Captures the real Settings surface and the widget's own LiveCardView, not a mock.
/// This is preview evidence, not proof of ActivityKit delivery or Lock Screen actions.
@MainActor
final class LiveDashboardEvidenceTests: XCTestCase {
    func testSettingsPreviewEvidence() {
        continueAfterFailure = false
        for level in ["minimal", "standard", "detailed"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-theme", "light",
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL",
                "-liveActivityLevel", level, "-uiTestPhoneProvider"
            ]
            // The baseline's in-process provider opens Chats without pairing, a real key,
            // or a network request. Do not use -uiTestLiveCard: ActivityKit can refuse
            // simulator requests and its system presentation is not the Settings preview.
            app.launch()
            defer { app.terminate() }

            let menu = app.buttons["chats.menu"].firstMatch
            XCTAssertTrue(menu.waitForExistence(timeout: 15), "offline fixture opens Chats")
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                let frame = menu.frame
                if menu.isHittable, !frame.isEmpty,
                   app.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) { break }
                RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            }
            XCTAssertTrue(menu.isHittable)
            menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let settings = app.buttons["Settings"].firstMatch
            XCTAssertTrue(settings.waitForExistence(timeout: 5))
            settings.tap()

            let liveActivities = app.buttons["settings.liveActivities"].firstMatch
            for _ in 0..<12 {
                if liveActivities.exists && liveActivities.isHittable { break }
                app.swipeUp()
            }
            XCTAssertTrue(liveActivities.exists && liveActivities.isHittable, "Settings offers Live Activities")
            liveActivities.tap()
            XCTAssertTrue(app.navigationBars["Live Activities"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.otherElements["Preview of the Lock Screen"].firstMatch.waitForExistence(timeout: 5),
                          "the real native card preview is on screen")
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "live-dashboard-settings-\(level)"
            shot.lifetime = .keepAlways
            add(shot)
        }
    }
}
