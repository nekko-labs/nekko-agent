import XCTest

/// "Send your first prompt" (`-uiTestFirstPromptIntro`): the three steps, Back, and Get started closing it.
/// Each step is a screenshot attachment.
@MainActor
final class FirstPromptIntroUITests: XCTestCase {
    override func setUp() async throws { continueAfterFailure = false }

    func testWalksTheThreeStepsAndCloses() throws {
        let app = XCUIApplication()
        let theme = ProcessInfo.processInfo.environment["NEKKO_ITEST_THEME"] ?? "light"
        app.launchArguments = ["-uiTestFirstPromptIntro", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", theme]
        app.launch()
        let step = app.descendants(matching: .any)["firstPromptIntro.step"]
        XCTAssertTrue(step.waitForExistence(timeout: 10))
        XCTAssertTrue(step.label.contains("Start with a question"))
        XCTAssertTrue(app.buttons["firstPromptIntro.skip"].exists, "Skip is one tap away")
        sleep(3)
        attach(app, "first-prompt-1-\(theme)")

        app.buttons["firstPromptIntro.next"].tap()
        XCTAssertTrue(step.label.contains("Add photos and a folder"))
        sleep(4)
        attach(app, "first-prompt-2-\(theme)")
        app.buttons["firstPromptIntro.back"].tap()
        XCTAssertTrue(step.label.contains("Start with a question"), "Back returns a step")
        app.buttons["firstPromptIntro.next"].tap()

        app.buttons["firstPromptIntro.next"].tap()
        XCTAssertTrue(step.label.contains("Tap Start"))
        XCTAssertFalse(app.buttons["firstPromptIntro.skip"].exists, "the last step has Get started, not Skip")
        sleep(4)
        attach(app, "first-prompt-3-\(theme)")
        app.buttons["firstPromptIntro.done"].tap()
        XCTAssertTrue(step.waitForNonExistence(timeout: 5), "Get started closes it")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
