import XCTest

@MainActor
final class TurnDetailsTests: XCTestCase {
    private func launch(_ extra: [String] = [], theme: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestTurnDetails", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", theme, "-expertMode", "NO", "-simpleChoices", "{}"] + extra
        app.launch()
        return app
    }

    private func footer(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "turn.details.measured").firstMatch
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Safe to run with just this fixture + registration + test copied onto the
    /// exact base revision: it makes no claim that the footer already exists.
    /// Label the artifact before/after only after checking the source revision.
    func testCaptureFixture() {
        let app = launch()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The focused tests pass")).firstMatch.waitForExistence(timeout: 10))
        capture(app, "turn-details-fixture")
    }

    func testCompletedReplyShowsActualModelEffortCountsRateAndDone() {
        let app = launch()
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        XCTAssertTrue(details.label.hasPrefix("Done."))
        for text in ["used-model", "used-provider", "High effort", "1.3k in", "500 out", "50 tok/s", "50s"] {
            XCTAssertTrue(details.label.contains(text), text)
        }
        XCTAssertFalse(details.label.contains("selected-model"))
        XCTAssertFalse(details.label.contains("Low effort"))
        XCTAssertTrue(details.isHittable)
        capture(app, "turn-details-complete-light")
    }

    func testInterruptedAndLoopRepliesNeverShowSuccess() {
        for flag in ["-turnDetailsInterrupted", "-turnDetailsLoop"] {
            let app = launch([flag])
            let details = footer(app)
            XCTAssertTrue(details.waitForExistence(timeout: 10))
            XCTAssertFalse(details.label.hasPrefix("Done."))
            XCTAssertTrue(details.label.contains("500 out"))
            capture(app, "turn-details" + flag)
            app.terminate()
        }
    }

    func testUntimedToolOnlyTurnKeepsDetailsWhenStepsAreFolded() {
        let app = launch(["-turnDetailsToolOnly", "-turnDetailsUntimed"], theme: "dark")
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        XCTAssertTrue(details.label.hasPrefix("Done."))
        XCTAssertTrue(details.label.contains("500 out"))
        XCTAssertFalse(details.label.contains("tok/s"), "wall time must not become decode speed")
        XCTAssertTrue(details.isHittable)
        capture(app, "turn-details-tool-only-untimed-dark")
    }

    func testLegacyReplyHasNoInventedMetricsOrSuccess() {
        let app = launch(["-turnDetailsLegacy"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The focused tests pass")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(footer(app).exists)
        capture(app, "turn-details-legacy")
    }

    func testDetailsWrapAtLargestDynamicType() {
        let app = launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        if !details.isHittable { app.swipeUp() }
        XCTAssertTrue(details.isHittable)
        XCTAssertGreaterThanOrEqual(details.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(details.frame.maxX, app.frame.maxX)
        XCTAssertTrue(details.label.contains("50 tok/s"))
        capture(app, "turn-details-accessibility-xxxl")
    }
}
