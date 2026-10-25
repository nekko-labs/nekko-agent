import XCTest

/// The chat's Markdown on the phone (MD-2), on the Debug-only fixture screen
/// (`-uiTestMarkdownLab`): the real `BlockView` drawing a reply and the user's
/// own message, with no computer paired.
final class MarkdownTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Nested lists with markers by depth, task boxes, a native table read by
    /// rows, a wide table that expands full screen, and a Markdown user bubble.
    func testRepliesAndMessagesRenderListsAndTables() {
        for theme in uiTestThemes {
            let app = launchLab(theme: theme)
            XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 15), "the reply is drawn")
            // A numbered list nested under a numbered item counts in letters.
            XCTAssertTrue(app.staticTexts["a."].exists, "second-level numbers are letters")
            XCTAssertTrue(app.images["Done"].exists, "a done task is a checkbox")
            // VoiceOver hears a table as rows.
            XCTAssertTrue(app.staticTexts["Row 1 of 3: Name, Nekko; Status, done; Count, 3"].exists, "table rows are announced")
            attach(app, "markdown-\(theme)-1-reply")

            let expand = app.buttons["markdown.table.expand"]
            scrollTo(expand, in: app)
            attach(app, "markdown-\(theme)-2-tables")
            expand.tap()
            let done = app.buttons["markdown.table.done"]
            XCTAssertTrue(done.waitForExistence(timeout: 5), "the wide table opens full screen")
            attach(app, "markdown-\(theme)-3-table-expanded")
            done.tap()

            // Long-pressing a table offers its own copy actions (once: the menu is the system's in either theme).
            if theme == uiTestThemes.first {
                let table = app.staticTexts["Row 1 of 3: Name, Nekko; Status, done; Count, 3"]
                scrollTo(table, in: app)
                table.press(forDuration: 1.2)
                XCTAssertTrue(app.buttons["Copy as Markdown"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.buttons["Copy as text"].exists)
                attach(app, "markdown-\(theme)-4-table-menu")
                app.buttons["Copy as text"].tap()
            }

            let sent = app.descendants(matching: .any)["lab.sent.0"]
            scrollTo(sent, in: app)
            attach(app, "markdown-\(theme)-5-user-bubble")
            app.terminate()
        }
    }

    /// The largest accessibility text size: tables scroll rather than truncate.
    func testLargestTextSize() {
        let app = launchLab(theme: "light", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
        XCTAssertTrue(app.staticTexts["Release checklist"].waitForExistence(timeout: 15))
        attach(app, "markdown-xl-1-reply")
        let expand = app.buttons["markdown.table.expand"]
        scrollTo(expand, in: app)
        attach(app, "markdown-xl-2-tables")
    }

    // MARK: Helpers

    func launchLab(theme: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", theme, "-uiTestMarkdownLab"] + extra
        app.launch()
        return app
    }

    /// Swipe until `element` is on screen above the bottom bar (a lazy list's rows exist, and
    /// report hittable, before they are scrolled into view).
    func scrollTo(_ element: XCUIElement, in app: XCUIApplication, max: Int = 12) {
        let window = app.windows.firstMatch.frame
        func visible() -> Bool {
            guard element.exists else { return false }
            let f = element.frame
            return !f.isEmpty && f.minY > window.minY + 90 && f.maxY < window.maxY - 160
        }
        var n = 0
        while !visible() && n < max {
            let f = element.exists ? element.frame : .null
            if !f.isNull && f.maxY <= window.minY + 90 { app.swipeDown() } else { app.swipeUp() }
            n += 1
        }
    }

    func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
