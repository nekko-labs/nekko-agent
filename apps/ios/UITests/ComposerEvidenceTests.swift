import XCTest

/// #2448: the composer's bottom row as the desktop's (+, folder, asks-first, mic beside Send) and
/// New chat's icon-only Chat / Image toggle at the box's top right. In-memory fixtures only.
/// Runs unchanged on the base revision through native-mode-evidence.yml for the before shots:
/// it photographs first and asserts the new controls only when they exist.
@MainActor
final class ComposerEvidenceTests: XCTestCase {
    func testComposerEvidence() {
        let chat = launch(["-uiTestPhotoPreviews", "-appLock", "NO"])
        let field = chat.textViews.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertTrue(chat.buttons["composer.add"].waitForExistence(timeout: 10))
        attach(chat, "composer-chat")
        let folder = chat.buttons["composer.folder"]
        if folder.waitForExistence(timeout: 5) {
            XCTAssertTrue(chat.buttons["chat.asksFirst"].exists, "Simple's asks-first icon follows the folder")
            folder.tap()
            XCTAssertTrue(chat.buttons["Files"].waitForExistence(timeout: 5))
            attach(chat, "composer-chat-folder-menu")
        }
        chat.terminate()

        let newChat = launch(["-uiTestNewChat", "-onThisIPhone", "NO"])
        XCTAssertTrue(newChat.textViews["newChat.prompt"].waitForExistence(timeout: 15))
        attach(newChat, "composer-new-chat")
        let image = newChat.buttons["newChat.kind.image"]
        if image.waitForExistence(timeout: 3) {
            XCTAssertTrue(newChat.buttons["newChat.folder"].exists)
            image.tap()
            XCTAssertTrue(image.isSelected)
            attach(newChat, "composer-new-chat-image")
        }
    }

    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset", "-onboardingDone", "YES", "-theme", "nekko-plum", "-splash", "NO"] + args
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
