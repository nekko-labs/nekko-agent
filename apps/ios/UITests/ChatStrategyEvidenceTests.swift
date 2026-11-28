import XCTest

@MainActor
final class ChatStrategyEvidenceTests: XCTestCase {
    func testStrategyAfterPrompts() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-refreshStrategy", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "computer", "-expertMode", "YES", "-AppleLanguages", "(en)"]
        app.launch()
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The ledgers agree")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 15))
        let rows = app.descendants(matching: .any).matching(identifier: "turn-strategy").allElementsBoundByIndex
        let worker = rows.first { $0.label.contains("Planned sub-agent model: claude-sonnet-5-5") }
        XCTAssertNotNil(worker)
        let prompt = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Delegate the ledger review.")).firstMatch
        if let worker {
            XCTAssertLessThan(prompt.frame.maxY, worker.frame.minY)
            XCTAssertLessThan(worker.frame.maxY, reply.frame.minY)
        }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-strategy"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
