import XCTest

/// The model picker's All / Cloud / Local tabs over a seeded computer (one cloud
/// provider, one local), with no pairing or network.
@MainActor
final class ModelTabsTests: XCTestCase {
    func testCloudAndLocalTabsFilterTheComputersModels() {
        let app = XCUIApplication()
        app.launchArguments = ["-splash", "NO", "-appLock", "NO", "-onboarded", "YES", "-uiTestReset", "YES",
                               "-theme", "computer", "-AppleLanguages", "(en)", "-uiTestModelTabs"]
        app.launch()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 10))
        XCTAssertTrue(tabs.buttons["All"].isSelected, "the picker opens on All, as on the desktop")
        let cloud = row("Claude Opus 5.5", in: app), local = row("Qwen3 8B", in: app)
        XCTAssertTrue(cloud.waitForExistence(timeout: 5))
        XCTAssertTrue(local.exists)
        attach(app, "iphone-model-tabs-all")

        tabs.buttons["Cloud"].tap()
        XCTAssertTrue(cloud.waitForExistence(timeout: 3))
        XCTAssertFalse(local.exists, "Cloud hides the local model server")
        attach(app, "iphone-model-tabs-cloud")

        tabs.buttons["Local"].tap()
        XCTAssertTrue(local.waitForExistence(timeout: 3))
        XCTAssertFalse(cloud.exists, "Local hides the cloud provider")
        attach(app, "iphone-model-tabs-local")

        tabs.buttons["All"].tap()
        XCTAssertTrue(cloud.waitForExistence(timeout: 3))
        XCTAssertTrue(local.exists)
    }

    private func row(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
