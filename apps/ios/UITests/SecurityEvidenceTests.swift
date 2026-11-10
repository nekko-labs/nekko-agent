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

    /// "Always allow this tool" from outside the chat: the notification action's link
    /// opens the chat, whose card runs its own "Always allow" for that call. (The
    /// Lock Screen card is a totals dashboard since #2047 and no longer carries an
    /// approval strip; it stays in the shot for context.) This fixture phone
    /// has no Change key, so the save is refused, as a cancelled Face ID would be:
    /// the card shows why, and the call still waits, approved by nobody.
    func testAlwaysAllowFromTheLockScreenOrANotificationEvidence() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestSecurityEvidence", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", "light", "-expertMode", "NO", "-simpleChoices", "{}",
                               "-securityEvidenceCard", "YES",
                               "-securityEvidenceOpen", "nekko-agent://chat/security-evidence?alwaysAllow=post",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        let waiting = app.buttons["approval.alwaysAllow"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 10), "the chat's approval card")
        let refused = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t send that")).firstMatch
        let ran = refused.waitForExistence(timeout: 8)
        // Photographed before the checks, so the revision without the feature is captured too.
        attach(app, "always-allow-from-outside")

        let card = app.descendants(matching: .any)["securityEvidence.card"]
        XCTAssertTrue(card.exists, "the Lock Screen card is shown")
        // Decision 0070 replaced the approval strip with totals. Check the actual fixture's
        // counts, not just a container, while the in-app signed action is still refused below.
        for (count, title) in [(0, "Building"), (1, "Need input"), (0, "Done")] {
            let metric = card.descendants(matching: .any).matching(NSPredicate(
                format: "label CONTAINS %@ AND label MATCHES %@", title, "(?s).*\\b\(count)\\b.*")).firstMatch
            XCTAssertTrue(metric.exists, "the dashboard shows \(count) \(title)")
        }
        XCTAssertTrue(card.staticTexts["Open app"].exists, "the dashboard hands approvals back to the app")
        XCTAssertFalse(card.staticTexts["Always allow"].exists, "the dashboard does not offer an approval strip")
        XCTAssertFalse(card.buttons["approval.alwaysAllow"].exists, "an approval cannot run from the dashboard")
        XCTAssertTrue(ran, "the link ran the card's own Always allow")
        XCTAssertTrue(waiting.exists, "a refused save approves nothing: the call still waits")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
