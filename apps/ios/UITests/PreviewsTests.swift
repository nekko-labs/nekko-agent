import XCTest

/// Real native rendering and WebKit interaction over isolated protocol responses.
/// No paired computer, network service, real files or credentials.
@MainActor
final class PreviewsTests: XCTestCase {
    private func launch(large: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        let theme = ProcessInfo.processInfo.environment["NEKKO_ITEST_THEME"] ?? "light"
        app.launchArguments = ["-uiTestPreviews", "-splash", "NO", "-AppleLanguages", "(en)", "-theme", theme]
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        XCTAssertTrue(app.buttons["Cards"].waitForExistence(timeout: 15))
        return app
    }

    func testCardsOpenInteractiveHTMLReloadAndReturnToReply() {
        let app = launch()
        let card = app.buttons.matching(identifier: "preview.card").element(boundBy: 0)
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(card.label.contains("Release prototype"))
        XCTAssertGreaterThanOrEqual(card.frame.height, 44)
        attach(app, "preview-cards")
        card.tap()
        let demo = app.webViews.buttons["Try prototype"]
        XCTAssertTrue(demo.waitForExistence(timeout: 15))
        attach(app, "preview-html-before-interaction")
        demo.tap()
        XCTAssertTrue(app.webViews.buttons["Prototype confirmed"].waitForExistence(timeout: 5))
        attach(app, "preview-html-interacted")
        app.buttons["preview.reload"].tap()
        XCTAssertTrue(demo.waitForExistence(timeout: 15), "reload rereads the source and resets the prototype")
        app.buttons["preview.done"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let notes = app.buttons.matching(identifier: "preview.card").element(boundBy: 1)
        if !notes.isHittable { app.swipeUp() }
        notes.tap()
        XCTAssertTrue(app.staticTexts["Release notes"].waitForExistence(timeout: 5))
        attach(app, "preview-markdown")
        app.buttons["preview.done"].tap()
    }

    func testLoopbackAndUnavailablePreviewRemainInsideTheNativeWindow() {
        let app = launch()
        app.buttons["Server"].tap()
        let card = app.buttons.matching(identifier: "preview.card").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(card.label.contains("localhost:5173"))
        card.tap()
        XCTAssertTrue(app.webViews.buttons["Try prototype"].waitForExistence(timeout: 15))
        app.webViews.buttons["Try prototype"].tap()
        XCTAssertTrue(app.webViews.buttons["Prototype confirmed"].exists)
        attach(app, "preview-loopback")
        app.buttons["preview.done"].tap()
        app.buttons["Unavailable"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.tap()
        XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 10))
        attach(app, "preview-unavailable")
        app.buttons["Try again"].tap()
        XCTAssertTrue(app.staticTexts["Couldn’t open the preview"].waitForExistence(timeout: 10))
        app.buttons["preview.done"].tap()
        XCTAssertTrue(app.buttons["Cards"].waitForExistence(timeout: 5))
    }

    func testWideTableScrollsExpandsAndKeepsAccessibleRowsAtLargeText() {
        let app = launch(large: true)
        app.buttons["Table"].tap()
        let row = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Row 1 of 2")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("Final column"))
        let expand = app.buttons["markdown.table.expand"]
        if !expand.isHittable { app.swipeUp() }
        XCTAssertTrue(expand.isHittable)
        attach(app, "preview-table-large-text")
        expand.tap()
        XCTAssertTrue(app.buttons["markdown.table.done"].waitForExistence(timeout: 5))
        attach(app, "preview-table-expanded-left")
        // The UIKit table zoom view supports panning as well as native pinch.
        app.swipeLeft()
        attach(app, "preview-table-expanded-right")
        let actions = app.buttons["Table actions"]
        actions.tap()
        XCTAssertTrue(app.buttons["Copy as Markdown"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Copy as text"].exists)
        app.buttons["Copy as Markdown"].tap()
        app.buttons["markdown.table.done"].tap()
        XCTAssertTrue(app.buttons["Cards"].waitForExistence(timeout: 5))
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
