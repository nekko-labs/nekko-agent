import XCTest

/// Synthetic native evidence; no provider, relay, downloads or hardware authorization.
/// Parent runs on the final source ref with the existing native-mode-evidence workflow.
final class ImageChatEvidenceTests: XCTestCase {
    @MainActor
    func testImageChatControlsGenerationAndExistingPhotoViewer() throws {
        let app = launch()
        let kind = app.segmentedControls["newChat.kind"]
        XCTAssertTrue(kind.waitForExistence(timeout: 10))
        kind.buttons["Image"].tap()
        capture("ImageChat-kind-local-only", app)
        app.buttons["newChat.imageSettings"].tap()
        let model = app.buttons["imageChat.model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        model.tap()
        app.buttons["FLUX local"].tap()
        capture("ImageChat-model-and-parameters", app)
        app.buttons["Done"].tap()
        let start = app.buttons["newChat.start"]
        XCTAssertTrue(start.isEnabled)
        start.tap()
        let photo = app.buttons["chat.photo"].firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 15), "The signed image turn renders its assistant attachment")
        capture("ImageChat-generated-assistant-attachment", app)
        photo.tap()
        capture("ImageChat-existing-authorized-photo-viewer", app)
    }

    /// Edit under a made picture puts it in the message box; Send makes the edit (images + size, signed).
    @MainActor
    func testEditAMadePicture() throws {
        let app = launch()
        let kind = app.segmentedControls["newChat.kind"]
        XCTAssertTrue(kind.waitForExistence(timeout: 10))
        kind.buttons["Image"].tap()
        app.buttons["newChat.imageSettings"].tap()
        let model = app.buttons["imageChat.model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        model.tap()
        app.buttons["FLUX local"].tap()
        app.buttons["Done"].tap()
        app.buttons["newChat.start"].tap()
        let edit = app.buttons["chat.editPicture"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 15), "A made picture offers Edit")
        capture("ImageChat-made-picture-with-edit", app)
        edit.tap()
        let field = app.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Make the sky orange")
        capture("ImageChat-edit-attached-in-composer", app)
        app.buttons["Send"].tap()
        // The edit is a second made picture, with its own Edit.
        let two = expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: app.buttons.matching(identifier: "chat.editPicture"))
        wait(for: [two], timeout: 15)
        capture("ImageChat-edited-picture", app)
    }

    @MainActor
    func testOlderHostExplicitlyDisallowsImageGeneration() throws {
        let app = launch(["-imageOldHost"])
        let kind = app.segmentedControls["newChat.kind"]
        XCTAssertTrue(kind.waitForExistence(timeout: 10))
        kind.buttons["Image"].tap()
        XCTAssertFalse(app.buttons["newChat.start"].isEnabled)
        app.buttons["newChat.imageSettings"].tap()
        XCTAssertTrue(app.staticTexts["imageChat.error"].waitForExistence(timeout: 5))
        capture("ImageChat-older-host-no-text-fallback", app)
    }

    @MainActor
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-uiTestNewChat", "-uiTestImageChat", "-onboardingDone", "YES", "-onThisIPhone", "NO", "-theme", "nekko-plum", "-splash", "NO"] + extra
        app.launch()
        return app
    }

    @MainActor
    private func capture(_ name: String, _ app: XCUIApplication) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
