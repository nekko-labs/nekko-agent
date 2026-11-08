import XCTest

/// Photo chats on the iPhone (#2177, decision 0069), against the in-memory
/// computer in PhotoPreviewFixture: make a picture, watch its progress, Edit it.
@MainActor
final class PhotoChatTests: XCTestCase {
    func testMakeAPictureThenEditIt() {
        let app = launch()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.descendants(matching: .any)["composer.pictureModel"].exists)
        attach(app, "photo-chat-prompt")

        app.buttons["Send"].tap()
        let generating = app.staticTexts["Generating a 1024×768 image"]
        XCTAssertTrue(generating.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Stop"].exists)
        attach(app, "photo-chat-progress")

        let picture = app.buttons.matching(identifier: "chat.madePicture")
        XCTAssertTrue(picture.firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["chat.editPicture"].exists)
        attach(app, "photo-chat-picture")

        app.buttons["chat.editPicture"].tap()
        XCTAssertTrue(app.buttons["composer.photo.0"].waitForExistence(timeout: 10))
        let box = app.textViews.firstMatch
        box.tap()
        box.typeText("Make it night")
        attach(app, "photo-chat-edit-attached")

        app.buttons["Send"].tap()
        let edited = NSPredicate(format: "count == 2")
        expectation(for: edited, evaluatedWith: picture)
        waitForExpectations(timeout: 20)
        attach(app, "photo-chat-edited")
        app.terminate()
    }

    func testWithoutAPictureModelThePhoneSaysWhereToChooseOne() {
        let app = launch(extra: ["-photoNoModel"])
        XCTAssertTrue(app.staticTexts["Choose a picture model for this chat on your computer."].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["Send"].isEnabled)
        attach(app, "photo-chat-no-model")
        app.terminate()
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-uiTestPhotoPreviews", "-photoChat", "-appLock", "NO", "-splash", "NO", "-theme", "dark"] + extra
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
