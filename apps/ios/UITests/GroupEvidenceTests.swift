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
            (setting: "chats.view.showModel", row: "chats.row.model"),
            (setting: "chats.view.showContext", row: "chats.row.context"),
            (setting: "chats.view.showPullRequests", row: "chats.row.prs"),
            (setting: "chats.view.showUpdated", row: "chats.row.updated"),
        ]
        if after {
            // Every field must initially be visible, not just absent after a toggle.
            for field in fields { XCTAssertTrue(row(app, field.row).exists, field.row) }
            for index in fields.indices {
                app.buttons["chats.view"].tap()
                app.buttons["Card details"].tap()
                if index == 0 {
                    attach(app, "card-details-menu")
                    let hierarchy = XCTAttachment(string: app.debugDescription)
                    hierarchy.name = "card-details-full-accessibility-tree"
                    hierarchy.lifetime = .keepAlways
                    add(hierarchy)
                }
                // A changed setting must not silently change any other field.
                for other in fields.indices {
                    let control = reveal(app, app.switches[fields[other].setting].firstMatch)
                    XCTAssertEqual(control.value as? String, other < index ? "0" : "1", fields[other].setting)
                }
                let control = reveal(app, app.switches[fields[index].setting].firstMatch)
                control.tap()
                XCTAssertEqual(control.value as? String, "0", fields[index].setting)
                closeViewOptions(app)
                for other in fields.indices {
                    XCTAssertEqual(row(app, fields[other].row).exists, other > index, fields[other].row)
                }
                if index == 0 { attach(app, "card-details-model-hidden") }
            }
            attach(app, "card-details-hidden")
            app.terminate()
            app.launchArguments += ["-uiTestKeepCardDetails"]
            app.launch()
            XCTAssertTrue(group.waitForExistence(timeout: 15))
            group.tap()
            for field in fields { XCTAssertFalse(row(app, field.row).exists, field.row) }
            attach(app, "card-details-persisted")
            app.buttons["chats.view"].tap()
            app.buttons["Card details"].tap()
            for field in fields {
                XCTAssertEqual(reveal(app, app.switches[field.setting].firstMatch).value as? String, "0", field.setting)
            }
            closeViewOptions(app)
        } else {
            app.buttons["chats.view"].tap()
            attach(app, "card-details-menu")
        }
    }

    private func row(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func reveal(_ app: XCUIApplication, _ element: XCUIElement) -> XCUIElement {
        let form = app.popovers.firstMatch.collectionViews.firstMatch
        // The Form scrolls inside the fixed-height popover. Return to its top before
        // searching down so each control is checked regardless of the previous one.
        if !element.isHittable { form.swipeDown() }
        for _ in 0..<4 {
            if element.isHittable { break }
            form.swipeUp()
        }
        XCTAssertTrue(element.exists)
        XCTAssertTrue(element.isHittable)
        return element
    }

    private func closeViewOptions(_ app: XCUIApplication) {
        reveal(app, app.buttons["chats.view.done"]).tap()
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
