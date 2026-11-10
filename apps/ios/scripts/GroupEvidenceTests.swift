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
        let fields = [
            (setting: "chats.view.showModel", marker: "Model opus"),
            (setting: "chats.view.showContext", marker: "Context window"),
            (setting: "chats.view.showPullRequests", marker: "Pull request 42, open"),
            (setting: "chats.view.showUpdated", marker: " ago"),
        ]
        if after {
            // ChatRow combines its children: verify every spoken field before
            // toggling, then verify each change leaves all other fields intact.
            for field in fields { XCTAssertTrue(row(app).label.contains(field.marker), field.marker) }
            for index in fields.indices {
                app.buttons["chats.view"].tap()
                let control = app.buttons[fields[index].setting].firstMatch
                app.buttons["Card details"].tap()
                XCTAssertTrue(control.waitForExistence(timeout: 3), fields[index].setting)
                if index == 0 {
                    attach(app, "card-details-menu")
                    let hierarchy = XCTAttachment(string: app.debugDescription)
                    hierarchy.name = "card-details-full-accessibility-tree"
                    hierarchy.lifetime = .keepAlways
                    add(hierarchy)
                }
                XCTAssertTrue(control.isHittable, fields[index].setting)
                control.tap()
                XCTAssertTrue(control.waitForExistence(timeout: 3), "a toggle keeps its submenu open")
                closeCardViewOptions(app, control: control)
                for other in fields.indices {
                    XCTAssertEqual(row(app).label.contains(fields[other].marker), other > index, fields[other].marker)
                }
                if index == 0 { attach(app, "card-details-model-hidden") }
            }
            attach(app, "card-details-hidden")
            app.terminate()
            app.launchArguments += ["-uiTestKeepCardDetails"]
            app.launch()
            XCTAssertTrue(group.waitForExistence(timeout: 15))
            group.tap()
            for field in fields { XCTAssertFalse(row(app).label.contains(field.marker), field.marker) }
            attach(app, "card-details-persisted")
        } else {
            app.buttons["chats.view"].tap()
            attach(app, "card-details-menu")
        }
    }

    private func row(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "chats.row").firstMatch
    }

    private func closeCardViewOptions(_ app: XCUIApplication, control: XCUIElement) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)).tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: control)
        XCTAssertEqual(XCTWaiter().wait(for: [closed], timeout: 5), .completed, "a tap outside closes Card details")
    }

    func testGroupChoicesSurviveRelaunchAndSearch() {
        let remembersGroups = true // The harness matches the baseline persistence capability, not its before label.
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
