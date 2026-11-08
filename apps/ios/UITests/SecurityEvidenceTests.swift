import XCTest

/// Decision 0054 on the iPhone, over the real ChatView and an in-memory computer
/// (`-uiTestSecurityEvidence`): an MCP approval offers "Always allow this tool",
/// and choosing No restrictions in Simple's tool picker shows the warning first.
@MainActor
final class SecurityEvidenceTests: XCTestCase {
    func testAlwaysAllowAndYoloWarningEvidence() {
        let app = XCUIApplication()
        // `-skipYoloWarning NO` beats a "Don't warn me again" left on this simulator.
        app.launchArguments = ["-uiTestSecurityEvidence", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}", "-skipYoloWarning", "NO",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // (a) The MCP tool waits for approval, with the new button beside Deny and Allow.
        let always = app.buttons["approval.alwaysAllow"]
        XCTAssertTrue(always.waitForExistence(timeout: 10), "an MCP approval offers Always allow this tool")
        XCTAssertEqual(always.label, "Always allow this tool")
        XCTAssertTrue(app.buttons["Deny"].exists)
        XCTAssertTrue(app.buttons["Allow"].exists)
        attach(app, "always-allow-tool")

        // (b) Simple's "when the agent asks you" picker: No restrictions warns before anything changes.
        let picker = app.buttons["chat.asksFirst"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        let yolo = app.buttons["tools.yolo"]
        XCTAssertTrue(yolo.waitForExistence(timeout: 5))
        yolo.tap()
        let title = app.staticTexts["yoloWarning.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "choosing No restrictions shows the warning first")
        XCTAssertEqual(title.label, "Turn on No restrictions?")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The agent will run commands")).firstMatch.exists)
        XCTAssertTrue(app.buttons["yoloWarning.cancel"].exists)
        XCTAssertEqual(app.buttons["yoloWarning.confirm"].label, "Turn on No restrictions")
        XCTAssertTrue(app.switches["yoloWarning.dontWarn"].exists)
        attach(app, "yolo-warning")

        // Keep asking changes nothing.
        app.buttons["yoloWarning.cancel"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: title)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(picker.value as? String, "Ask when it matters")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
