import UIKit
import XCTest

/// The folding-phone panes (FD-3 to FD-6), exercised on the iPad simulator
/// (every open posture without a hinge) and with a hinge faked by the
/// `-fakeHinge` launch argument (App/Platform/Hinge.swift). Against the same
/// live stack as LiveRelayTests (apps/ios/scripts/itest-stack.sh): opt-in
/// with `TEST_RUNNER_NEKKO_ITEST_LINK`, and only on an iPad (a phone is
/// always one column). Each step is a screenshot attachment.
final class PanesTests: XCTestCase {
    /// The faked hinge's thickness (Hinge.thickness in the app).
    private let hinge: CGFloat = 24

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    /// Two chats stream side by side, each with its own composer; rotating to
    /// portrait stacks them, both still there, and the one scrolled back keeps its place.
    func testTwoChatsStreamRotateAndKeepTheirPlace() throws {
        let app = try launch(extra: [])
        XCUIDevice.shared.orientation = .landscapeLeft
        pairAndWait(app)
        attach(app, "panes-1-chats-and-chat")
        XCTAssertTrue(app.descendants(matching: .any)["panes.foldNote"].waitForExistence(timeout: 5), "the foldable note shows under the panes")

        // First chat: New chat from the list opens in the chat pane.
        startChat(app, "a long run please")
        XCTAssertTrue(app.staticTexts.matching(contains("word1")).firstMatch.waitForExistence(timeout: 45), "the first chat streams")

        // Second chat in the other pane: Replace with… → New chat on the list's pane.
        let list = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH 'pane.'")).allElementsBoundByIndex
            .first { $0.navigationBars["Chats"].exists }
        let listPane = try XCTUnwrap(list, "the list pane")
        listPane.buttons["pane.menu"].firstMatch.tap()
        app.buttons["Replace with…"].firstMatch.tap()
        app.buttons["New chat"].firstMatch.tap()
        startChat(app, "a long run please", tapNewChat: false)
        let panes = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH 'pane.'"))
        XCTAssertTrue(waitFor { panes.allElementsBoundByIndex.filter { $0.staticTexts.matching(self.contains("word1")).firstMatch.exists }.count == 2 },
                      "both chats stream at once")
        attach(app, "panes-2-chat-and-chat-streaming")

        // Each pane has its own composer.
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat.message").count, 2)

        // Scroll the left chat back; it stops following the stream.
        let left = panes.allElementsBoundByIndex.min { $0.frame.minX < $1.frame.minX }!
        let leftId = left.identifier
        left.scrollViews.firstMatch.swipeDown()
        left.scrollViews.firstMatch.swipeDown()
        XCTAssertTrue(left.buttons["Jump to latest"].waitForExistence(timeout: 5), "scrolled back from the end")
        attach(app, "panes-3-scrolled")

        // Rotate: the panes stack, the same two chats, the scrolled one still scrolled back.
        XCUIDevice.shared.orientation = .portrait
        let same = app.otherElements[leftId]
        XCTAssertTrue(waitFor { same.exists && panes.count == 2 && abs(panes.element(boundBy: 0).frame.minX - panes.element(boundBy: 1).frame.minX) < 1 },
                      "stacked after rotating")
        XCTAssertTrue(same.buttons["Jump to latest"].exists, "the scroll position was kept through the rotation")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "chat.message").count, 2, "both chats are still open")
        attach(app, "panes-4-stacked")

        // Swap and Focus from a pane's header.
        same.buttons["pane.menu"].firstMatch.tap()
        app.buttons["pane.focus"].firstMatch.tap()
        XCTAssertTrue(app.buttons["panes.edgeTab"].waitForExistence(timeout: 5), "Focus leaves the other pane as an edge tab")
        attach(app, "panes-5-focus")
        app.buttons["panes.edgeTab"].tap()
        XCTAssertTrue(waitFor { panes.allElementsBoundByIndex.filter(\.isHittable).count == 2 }, "both panes are back")
    }

    /// Tabletop (a horizontal hinge, half opened): the transcript above the
    /// hinge, the composer below it, nothing on the hinge.
    func testTabletopPutsTheComposerBelowTheHinge() throws {
        let app = try launch(extra: ["-fakeHinge", "tabletop"])
        XCUIDevice.shared.orientation = .landscapeLeft
        pairAndWait(app)
        // Tabletop shows the focused pane alone; the list waits as an edge tab.
        XCTAssertTrue(app.buttons["panes.edgeTab"].waitForExistence(timeout: 10))
        app.buttons["panes.edgeTab"].tap()
        startChat(app, "Say hello")
        XCTAssertTrue(app.staticTexts["Hello from your computer."].waitForExistence(timeout: 30), "the reply streamed in")

        let window = app.windows.firstMatch.frame
        let hingeTop = window.midY - hinge / 2, hingeBottom = window.midY + hinge / 2
        let message = app.input("chat.message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(message.frame.minY, hingeBottom, "the composer is below the hinge")
        let reply = app.staticTexts["Hello from your computer."]
        XCTAssertLessThanOrEqual(reply.frame.maxY, hingeTop, "the transcript is above the hinge")
        for b in app.buttons.allElementsBoundByIndex where b.isHittable {
            let f = b.frame
            XCTAssertFalse(f.minY < hingeBottom && f.maxY > hingeTop && f.width < window.width, "\(b.label) sits on the hinge")
        }
        attach(app, "panes-6-tabletop")

        message.tap()
        XCTAssertGreaterThanOrEqual(message.frame.minY, hingeBottom, "with the keyboard up the composer stays below the hinge")
        attach(app, "panes-7-tabletop-keyboard")
    }

    /// Book (a vertical hinge, half opened): side by side with the divider on the hinge.
    func testBookPutsTheDividerOnTheHinge() throws {
        let app = try launch(extra: ["-fakeHinge", "book"])
        XCUIDevice.shared.orientation = .landscapeLeft
        pairAndWait(app)
        let panes = app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH 'pane.'"))
        XCTAssertTrue(waitFor { panes.count == 2 })
        let window = app.windows.firstMatch.frame
        let left = panes.allElementsBoundByIndex.min { $0.frame.minX < $1.frame.minX }!
        let right = panes.allElementsBoundByIndex.max { $0.frame.minX < $1.frame.minX }!
        XCTAssertEqual(left.frame.maxX, window.midX - hinge / 2, accuracy: 2, "the left pane ends at the hinge")
        XCTAssertEqual(right.frame.minX, window.midX + hinge / 2, accuracy: 2, "the right pane starts after it")
        XCTAssertFalse(app.descendants(matching: .any)["panes.divider"].exists, "no draggable divider on a hinge")
        attach(app, "panes-8-book")
    }

    /// Monitors as a pane: hardware, running, needs you and automations from `monitor:summary`.
    func testMonitorsPane() throws {
        let app = try launch(extra: [])
        XCUIDevice.shared.orientation = .landscapeLeft
        pairAndWait(app)
        app.buttons["chats.monitors"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Monitors"].waitForExistence(timeout: 10), "Monitors takes the list's pane")
        XCTAssertTrue(app.staticTexts["Hardware"].waitForExistence(timeout: 15), "the first read arrived")
        XCTAssertTrue(app.staticTexts["Running"].exists)
        attach(app, "panes-9-monitors")
    }

    // MARK: Helpers

    private func launch(extra: [String]) throws -> XCUIApplication {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("two panes need a regular-width screen (an iPad simulator)") }
        guard ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"] != nil else {
            throw XCTSkip("set NEKKO_ITEST_LINK (apps/ios/scripts/itest-stack.sh)")
        }
        let app = XCUIApplication()
        let theme = ProcessInfo.processInfo.environment["NEKKO_ITEST_THEME"] ?? "light"
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", theme, "-uiTestReset", "YES",
                               "-paneTipShown", "NO", "-foldNoteDismissed", "NO", "-expertMode", "YES"] + extra
        app.launch()
        addUIInterruptionMonitor(withDescription: "system alerts") { alert in
            for label in ["Allow", "OK", "Allow While Using App"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        return app
    }

    private func pairAndWait(_ app: XCUIApplication) {
        let link = ProcessInfo.processInfo.environment["NEKKO_ITEST_LINK"] ?? ""
        let start = app.buttons["Pair with your computer"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let field = app.input("nekko-agent-pair:?relay=…")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(link)
        app.buttons["Pair"].firstMatch.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Allow"].waitForExistence(timeout: 4) { springboard.buttons["Allow"].tap() }
        let online = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Computers and settings, online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 30), "connected to the computer")
    }

    private func startChat(_ app: XCUIApplication, _ text: String, tapNewChat: Bool = true) {
        if tapNewChat { app.navigationBars.buttons["New chat"].firstMatch.tap() }
        let prompt = app.input("What should your computer do?")
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        prompt.tap()
        prompt.typeText(text)
        app.buttons["Start"].firstMatch.tap()
    }

    private func contains(_ s: String) -> NSPredicate { NSPredicate(format: "label CONTAINS %@", s) }

    private func waitFor(_ seconds: TimeInterval = 30, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
