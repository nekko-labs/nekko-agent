import XCTest

/// Recorder-backed native surface only. These tests do not claim APNs or SpringBoard evidence.
final class AttentionNotificationsUITests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestAttentionNotifications", "-splash", "NO"] + extra
        app.launch()
        XCTAssertTrue(app.navigationBars["Attention notifications"].waitForExistence(timeout: 10))
        return app
    }

    private func row(_ id: String, contains value: String, in app: XCUIApplication) {
        let element = app.descendants(matching: .any).matching(identifier: id).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        let predicate = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", value, value)
        expectation(for: predicate, evaluatedWith: element)
        waitForExpectations(timeout: 5)
    }

    func testOpeningDoesNotClearAnswerAndRemoteDismissDo() {
        let app = launch()
        row("attention-count", contains: "2", in: app)
        row("attention-badge", contains: "2", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["attention-banner"].firstMatch.exists)
        app.buttons["Open pending chat"].tap()
        row("attention-count", contains: "2", in: app)
        app.buttons["Answer active approval"].tap()
        row("attention-badge", contains: "1", in: app)
        app.buttons["Remote dismiss fleet question"].tap()
        row("attention-badge", contains: "0", in: app)
    }

    func testUnknownNeverWritesPartialAndReconnectReplacesPending() {
        let app = launch(["-attentionUnknown"])
        row("attention-count", contains: "Unknown", in: app)
        row("attention-badge", contains: "Unchanged", in: app)
        app.buttons["Reconnect with no pending input"].tap()
        row("attention-badge", contains: "0", in: app)
    }

    func testDisabledAndDeniedDeliverNoBanner() {
        for flag in ["-attentionDenied", "-attentionDisabled"] {
            let app = launch([flag])
            XCTAssertTrue(app.staticTexts["attention-no-banner"].waitForExistence(timeout: 5))
            if flag == "-attentionDenied" { row("attention-badge", contains: "Unchanged", in: app) }
            else { row("attention-badge", contains: "0", in: app) }
            app.terminate()
        }
    }
}
