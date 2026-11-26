import XCTest

@MainActor
final class ChatStrategyEvidenceTests: XCTestCase {
    func testStrategyChanges() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-refreshStrategy", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "computer", "-expertMode", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The ledgers agree")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15))
        let rows = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "Tool list · Direct", "Code mode · Orchestration"))
        let baseline = ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1"
        XCTAssertEqual(rows.count, baseline ? 0 : 2)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-strategy"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
