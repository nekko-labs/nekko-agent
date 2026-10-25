import UIKit
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

    /// MD-3/MD-5: the toolbar inside the message box writes a nested list and a
    /// table (Return continues and ends the list, Tab moves through cells),
    /// Send, and the same Markdown reads back rendered.
    func testToolbarWritesANestedListAndATable() {
        // One theme: the live journey photographs the composer in both, and Native iOS has a 50-minute budget.
        for theme in uiTestThemes.prefix(1) {
            let app = launchLab(theme: theme)
            let box = app.input("chat.message")
            XCTAssertTrue(box.waitForExistence(timeout: 15))
            box.tap()
            let bullet = app.buttons["composer.bullet"]
            XCTAssertTrue(bullet.waitForExistence(timeout: 5), "the toolbar shows while the box is focused")
            attach(app, "composer-\(theme)-1-toolbar")

            bullet.tap()
            box.typeText("Plan\n")
            app.buttons["composer.indent"].tap()
            box.typeText("nested ")
            app.buttons["composer.bold"].tap()
            box.typeText("bold")
            XCTAssertTrue(app.buttons["composer.bold"].isSelected, "Bold shows pressed inside bold text")
            app.buttons["composer.bold"].tap()
            box.typeText("\n\n")
            XCTAssertEqual(box.value as? String, "- Plan\n  - nested **bold**\n", "Return continued the list, then ended it")
            attach(app, "composer-\(theme)-2-list")

            app.buttons["composer.table"].tap()
            XCTAssertTrue(app.buttons["composer.addRow"].waitForExistence(timeout: 5), "inside a table the toolbar adds rows and columns")
            box.typeText("Name\tStatus\tPhone\tdone")
            XCTAssertEqual(box.value as? String, "- Plan\n  - nested **bold**\n| Name | Status |\n| --- | --- |\n| Phone | done |")
            attach(app, "composer-\(theme)-3-table")

            app.buttons["Send"].tap()
            let row = app.staticTexts["Row 1 of 1: Name, Phone; Status, done"]
            scrollTo(row, in: app)
            XCTAssertTrue(row.exists, "the sent table reads back as a table")
            XCTAssertTrue(app.staticTexts["nested bold"].exists, "the nested item reads back with its bold")
            attach(app, "composer-\(theme)-4-sent")
            app.terminate()
        }
    }

    /// MD-4: a normal paste of rich text stays plain, then *Use formatting* swaps in its Markdown.
    func testRichPasteOffersFormatting() {
        UIPasteboard.general.items = [[
            "public.html": Data("<p>Ship <b>today</b></p><ul><li>one<ul><li>two</li></ul></li></ul>".utf8),
            "public.utf8-plain-text": "Ship today\none\ntwo",
        ]]
        let app = launchLab(theme: "light")
        let box = app.input("chat.message")
        XCTAssertTrue(box.waitForExistence(timeout: 15))
        box.tap()
        box.tap()
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "the edit menu offers Paste")
        let ours = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Paste as Markdown")).firstMatch
        XCTAssertTrue(ours.exists, "and Paste as Markdown")
        attach(app, "composer-paste-1-menu")
        paste.tap()
        XCTAssertEqual(box.value as? String, "Ship today\none\ntwo", "a normal paste is plain text")
        let chip = app.buttons["composer.useFormatting"]
        XCTAssertTrue(chip.waitForExistence(timeout: 3), "the chip offers the formatting")
        attach(app, "composer-paste-2-chip")
        chip.tap()
        XCTAssertEqual(box.value as? String, "Ship **today**\n\n- one\n  - two")
        attach(app, "composer-paste-3-formatted")
    }

    /// MM-3: a flowchart and a sequence diagram draw inline, a broken one falls
    /// back to its source with Mermaid's error, a diagram opens full screen, and
    /// the renderer cannot reach the network. Render times go to the log.
    func testDiagramsDrawAndABrokenOneFallsBack() {
        for theme in uiTestThemes {
            let app = launchLab(theme: theme, extra: ["-labDiagrams"])
            let flowchart = app.buttons["Diagram, flowchart"]
            // The first diagram starts the renderer (loading the bundled Mermaid).
            XCTAssertTrue(flowchart.waitForExistence(timeout: 60), "the flowchart is drawn")
            let sequence = app.buttons["Diagram, sequence diagram"]
            XCTAssertTrue(sequence.waitForExistence(timeout: 30), "the sequence diagram is drawn")
            let error = app.staticTexts["mermaid.error"]
            XCTAssertTrue(error.waitForExistence(timeout: 30), "the broken diagram shows Mermaid's error")
            attach(app, "mermaid-\(theme)-1-flowchart")
            scrollTo(error, in: app)
            attach(app, "mermaid-\(theme)-2-sequence-and-broken")

            let network = app.staticTexts["lab.mermaidNetwork"]
            scrollTo(network, in: app, max: 6)
            let probed = expectation(for: NSPredicate(format: "label != %@", "Renderer network: "), evaluatedWith: network)
            wait(for: [probed], timeout: 20)
            XCTAssertEqual(network.label, "Renderer network: blocked", "the renderer can't reach the network")
            let times = app.staticTexts["lab.mermaidTimes"].label
            print("MERMAID-RENDER-TIMES \(theme): \(times)")
            let note = XCTAttachment(string: "\(theme): \(times)")
            note.name = "mermaid-\(theme)-render-times"
            note.lifetime = .keepAlways
            add(note)

            app.swipeDown(velocity: .fast)
            app.swipeDown(velocity: .fast)
            flowchart.tap()
            let done = app.buttons["mermaid.done"]
            XCTAssertTrue(done.waitForExistence(timeout: 10), "the diagram opens full screen")
            RunLoop.current.run(until: Date().addingTimeInterval(1.5))
            attach(app, "mermaid-\(theme)-3-fullscreen")
            app.buttons["mermaid.actions"].tap()
            XCTAssertTrue(app.buttons["Copy source"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["Save to Photos"].exists)
            attach(app, "mermaid-\(theme)-4-actions")
            app.buttons["Copy source"].tap()
            done.tap()
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
        let box = app.input("chat.message")
        box.tap()
        XCTAssertTrue(app.buttons["composer.bullet"].waitForExistence(timeout: 5))
        attach(app, "composer-xl-toolbar")
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
