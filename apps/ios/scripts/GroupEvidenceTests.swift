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
            // ChatRow combines its children: inspect its real spoken label rather than
            // child identifiers that are not exposed. The English offline fixture
            // has a timestamp several days old ("… ago"), never a live seconds ticker.
            // Every field must initially be visible, not just absent after a toggle.
            for field in fields { XCTAssertTrue(row(app).label.contains(field.marker), field.marker) }
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
                // Native AX represents this Form toggle as a 308pt-wide row
                // containing the actual 63pt switch. The row's label center is
                // inert; drive the child control whose frame the AX tree records.
                let thumb = control.switches.firstMatch
                XCTAssertTrue(thumb.exists, fields[index].setting)
                XCTAssertTrue(control.frame.contains(thumb.frame), fields[index].setting)
                XCTAssertTrue(thumb.isHittable, fields[index].setting)
                thumb.tap()
                XCTAssertEqual(control.value as? String, "0", fields[index].setting)
                closeCardViewOptions(app)
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
            app.buttons["chats.view"].tap()
            app.buttons["Card details"].tap()
            for field in fields {
                XCTAssertEqual(reveal(app, app.switches[field.setting].firstMatch).value as? String, "0", field.setting)
            }
            closeCardViewOptions(app)
        } else {
            app.buttons["chats.view"].tap()
            attach(app, "card-details-menu")
        }
    }

    private func row(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "chats.row").firstMatch
    }

    private func reveal(_ app: XCUIApplication, _ element: XCUIElement) -> XCUIElement {
        let popover = app.popovers.firstMatch
        let form = popover.collectionViews.firstMatch
        // Search toward the bottom first: an unseen row is virtualized below the
        // fold. Do not pull down at the top, which dismissed the native popover.
        // Keep both drag endpoints inside the Form and away from its controls.
        for down in [false, true] {
            for attempt in 0...4 {
                guard popover.exists, form.exists else {
                    XCTFail("View options must remain open while revealing a field")
                    return element
                }
                if element.exists, !element.frame.isEmpty,
                   popover.frame.contains(element.frame), element.isHittable {
                    return element
                }
                if attempt < 4 {
                    let start = form.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: down ? 0.25 : 0.8))
                    let end = form.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: down ? 0.8 : 0.25))
                    start.press(forDuration: 0.05, thenDragTo: end)
                }
            }
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "card-details-field-not-reachable"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTAssertTrue(element.exists)
        XCTAssertTrue(popover.frame.contains(element.frame))
        XCTAssertTrue(element.isHittable)
        return element
    }

    private func closeCardViewOptions(_ app: XCUIApplication) {
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
