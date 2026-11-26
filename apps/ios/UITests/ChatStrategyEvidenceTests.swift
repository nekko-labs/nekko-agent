import XCTest

@MainActor
final class ChatStrategyEvidenceTests: XCTestCase {
    func testStrategyChanges() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-refreshStrategy", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "computer", "-expertMode", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The ledgers agree")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15))
        let rows = app.descendants(matching: .any).matching(identifier: "turn-strategy").allElementsBoundByIndex
        let baseline = ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1"
        XCTAssertEqual(rows.map(\.label), baseline ? [] : ["Strategy: Tool list · Direct", "Strategy: Code mode · Orchestration"])
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-strategy"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
