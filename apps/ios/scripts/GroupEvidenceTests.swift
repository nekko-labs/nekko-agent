import XCTest

@MainActor
final class GroupEvidenceTests: XCTestCase {
    func testChatGroups() {
        let after = true // The evidence harness sets false only for the baseline revision.
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestGroupList", "-splash", "NO", "-AppleLanguages", "(en)"]
        app.launch()
        let group = app.buttons["chats.group.status:building"]
        XCTAssertTrue(group.waitForExistence(timeout: 15))
        XCTAssertEqual(group.value as? String, "Collapsed")
        attach(app, "card-groups-default")
        group.tap()
        XCTAssertEqual(group.value as? String, "Expanded")
        XCTAssertTrue(app.staticTexts["Build the app"].waitForExistence(timeout: 5))
        attach(app, "card-groups-expanded")
        app.buttons["chats.view"].tap()
        if after {
            app.buttons["Card details"].tap()
            attach(app, "card-details-menu")
            app.buttons["Model"].tap()
            // A menu toggle dismisses the native menu; the other fields must stay on.
            XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Model opus")).firstMatch.exists)
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Context window:")).firstMatch.exists)
            for label in ["Context window", "Pull requests", "Last updated"] {
                app.buttons["chats.view"].tap()
                app.buttons["Card details"].tap()
                app.buttons[label].tap()
            }
            attach(app, "card-details-hidden")
            XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Context window:")).firstMatch.exists)
            app.terminate()
            app.launchArguments += ["-uiTestKeepCardDetails"]
            app.launch()
            XCTAssertTrue(group.waitForExistence(timeout: 15))
            group.tap()
            XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Model opus")).firstMatch.exists)
            XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Context window:")).firstMatch.exists)
            attach(app, "card-details-persisted")
        } else {
            attach(app, "card-details-menu")
        }
    }

    func testGroupChoicesSurviveRelaunchAndSearch() {
        let remembersGroups = true // The harness sets false for the unchanged baseline.
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestGroupList", "-splash", "NO", "-AppleLanguages", "(en)"]
        app.launch()
        let building = app.buttons["chats.group.status:building"]
        let watching = app.buttons["chats.group.status:watching"]
        XCTAssertTrue(building.waitForExistence(timeout: 15))
        XCTAssertEqual(building.value as? String, "Collapsed")
        building.tap()
        XCTAssertEqual(building.value as? String, "Expanded")
        XCTAssertEqual(watching.value as? String, "Collapsed")
        attach(app, "groups-before-relaunch")
        app.terminate()
        app.launchArguments += ["-uiTestKeepGroups"]
        app.launch()
        XCTAssertTrue(building.waitForExistence(timeout: 15))
        XCTAssertEqual(building.value as? String, remembersGroups ? "Expanded" : "Collapsed")
        XCTAssertEqual(watching.value as? String, "Collapsed")
        attach(app, "groups-after-relaunch")

        // Explicitly closing a group must also survive another launch.
        if !remembersGroups { building.tap() }
        building.tap()
        watching.tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(building.waitForExistence(timeout: 15))
        XCTAssertEqual(building.value as? String, "Collapsed")
        XCTAssertEqual(watching.value as? String, remembersGroups ? "Expanded" : "Collapsed")
        attach(app, "groups-closed-after-relaunch")

        app.buttons["chats.menu"].tap()
        app.buttons["chats.menu.search"].tap()
        let search = app.textFields["chats.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Build")
        XCTAssertEqual(building.value as? String, "Expanded")
        XCTAssertTrue(app.staticTexts["Build the app"].waitForExistence(timeout: 5))
        if remembersGroups { building.tap() } // Search disclosure must not write a preference.
        app.buttons["chats.search.cancel"].tap()
        XCTAssertEqual(building.value as? String, "Collapsed")
        XCTAssertEqual(watching.value as? String, remembersGroups ? "Expanded" : "Collapsed")
        attach(app, "groups-after-search")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
