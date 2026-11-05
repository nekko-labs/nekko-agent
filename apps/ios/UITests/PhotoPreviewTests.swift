import XCTest

@MainActor
final class PhotoPreviewTests: XCTestCase {
    func testComposerAndSentPhotos() {
        let app = launch()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["composer.photo.0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.photo.1"].exists)
        attach(app, "photo-chat-composer")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["A mountain and a sun."].waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons.matching(identifier: "chat.photo").count, 2)
        attach(app, "photo-chat-sent")
        app.buttons.matching(identifier: "chat.photo").element(boundBy: 1).tap()
        XCTAssertTrue(app.buttons["viewer.close"].waitForExistence(timeout: 5))
        attach(app, "photo-sent-viewer")
        app.buttons["viewer.close"].tap()
        app.terminate()
    }

    func testNewChatPhotos() {
        let app = launch(newChat: true)
        XCTAssertTrue(app.descendants(matching: .any)["newChat.prompt"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["composer.photo.0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.photo.1"].exists)
        attach(app, "photo-new-chat-composer")
        app.buttons["composer.photo.1"].tap()
        XCTAssertTrue(app.buttons["viewer.close"].waitForExistence(timeout: 5))
        app.buttons["viewer.close"].tap()
        app.buttons["composer.removePhoto.0"].tap()
        XCTAssertTrue(app.buttons["composer.photo.0"].exists)
        XCTAssertFalse(app.buttons["composer.photo.1"].exists)
        attach(app, "photo-new-chat-removed")
        app.terminate()
    }

    func testDuplicatePhotosAreIndependentlyRemovableAndPhotoOnlySendWorks() {
        let app = launch(extra: ["-photoOnly", "-duplicatePhotos"])
        XCTAssertTrue(app.buttons["composer.photo.1"].waitForExistence(timeout: 30))
        app.buttons["composer.removePhoto.0"].tap()
        XCTAssertTrue(app.buttons["composer.photo.0"].exists)
        XCTAssertFalse(app.buttons["composer.photo.1"].exists)
        app.buttons["composer.photo.0"].tap()
        XCTAssertTrue(app.buttons["viewer.close"].waitForExistence(timeout: 5))
        attach(app, "photo-composer-viewer")
        app.buttons["viewer.close"].tap()
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["A mountain and a sun."].waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons.matching(identifier: "chat.photo").count, 1)
        attach(app, "photo-only-sent")
        app.terminate()
    }

    private func launch(newChat: Bool = false, extra: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-uiTestPhotoPreviews", "-appLock", "NO", "-splash", "NO", "-theme", "dark"]
        if newChat { app.launchArguments.append("-photoNewChat") }
        app.launchArguments += extra
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
