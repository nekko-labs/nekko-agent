import XCTest

@MainActor
final class OrchestrateEvidenceTests: XCTestCase {
    func testRunSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestRunSettings", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-theme", "light", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Run settings"].waitForExistence(timeout: 10))
        let toggle = app.switches["run.orchestrate"]
        if ProcessInfo.processInfo.environment["NEKKO_EVIDENCE_BASELINE"] == "1" {
            XCTAssertFalse(toggle.exists)
            attach(app, "run-settings")
        } else {
            XCTAssertTrue(toggle.waitForExistence(timeout: 5))
            XCTAssertEqual(toggle.value as? String, "0")
            attach(app, "run-settings")
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            let on = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: toggle)
            XCTAssertEqual(XCTWaiter.wait(for: [on], timeout: 3), .completed)
            attach(app, "orchestrate-on")
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            let off = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: toggle)
            XCTAssertEqual(XCTWaiter.wait(for: [off], timeout: 3), .completed)
        }
    }

    private func attach(_ app: XCUIApplication, _ title: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = title
        image.lifetime = .keepAlways
        add(image)
    }
}
