import XCTest

final class PurposeGroupsTests: XCTestCase {
    func testGroupsRevealCallsAndKeepFailuresVisible() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestPurposeGroups", "-splash", "NO", "-AppleLanguages", "(en)"]
        app.launch()
        let groups = app.buttons.matching(identifier: "chat.purposeGroup")
        XCTAssertTrue(groups.element(boundBy: 0).waitForExistence(timeout: 10))
        XCTAssertEqual(groups.count, 3)
        XCTAssertEqual(groups.element(boundBy: 0).value as? String, "Calls hidden")
        XCTAssertEqual(groups.element(boundBy: 1).value as? String, "Calls shown")
        XCTAssertTrue(app.staticTexts["fixture.detail.failure"].exists)
        attach(app, "groups-default")
        groups.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["fixture.detail.success"].waitForExistence(timeout: 3))
        attach(app, "groups-expanded")
        groups.element(boundBy: 0).tap()
        XCTAssertEqual(groups.element(boundBy: 0).value as? String, "Calls hidden")
        groups.element(boundBy: 1).tap()
        XCTAssertEqual(groups.element(boundBy: 1).value as? String, "Calls hidden")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
