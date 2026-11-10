import XCTest

/// Real ChatView and NewChatView over an in-memory connection. No provider or real data.
@MainActor
final class StreamingStabilityTests: XCTestCase {
    private var baseline: Bool { ProcessInfo.processInfo.environment["NEKKO_STREAM_BASELINE"] == "1" }

    private func launch(_ flags: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestChatRefresh", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES"] + flags
        app.launch()
        return app
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testStreamingFollowsGrowthAndLetsTheReaderScrollBack() {
        let app = launch(["-refreshLongChat", "-refreshStream"])
        XCTAssertTrue(app.staticTexts["You are at the latest message."].waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 8)
        let metric = app.descendants(matching: .any)["stream.maxBackward"].firstMatch
        let sampled = NSPredicate { _, _ in
            Double(metric.value as? String ?? "") != nil
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: sampled, object: nil)], timeout: 30), .completed)
        let heights = metric.label.components(separatedBy: "; ").compactMap { sample -> Double? in
            guard let field = sample.components(separatedBy: " ").first(where: { $0.hasPrefix("height=") }) else { return nil }
            return Double(field.dropFirst(7))
        }
        XCTAssertGreaterThan((heights.max() ?? 0) - (heights.min() ?? 0), 100, "sampling must cover real streaming content growth")
        let trace = XCTAttachment(string: metric.label)
        trace.name = "stream-offset-and-content-size-trace"
        trace.lifetime = .keepAlways
        add(trace)
        print("STREAM_GEOMETRY_TRACE \(metric.label)")
        let regression = Double(metric.value as? String ?? "")
        XCTAssertNotNil(regression, "the fixture collected offset samples: \(metric.value ?? "nil")")
        if !baseline, let regression { XCTAssertLessThanOrEqual(regression, 1, "append-only streaming must not jump backward") }
        attach(app, "streaming-follow")
        // The stream is still growing. Scroll into history and make sure incoming tokens
        // do not force the reader back to the end.
        let transcript = app.scrollViews["chat.transcript"]
        transcript.swipeDown()
        Thread.sleep(forTimeInterval: 1)
        attach(app, "streaming-history")
        let jump = app.buttons["Jump to latest"]
        if !baseline { XCTAssertTrue(jump.waitForExistence(timeout: 5), "the reader can leave the end while streaming") }
        if jump.exists { jump.tap() }
        Thread.sleep(forTimeInterval: 2)
        attach(app, "streaming-resumed")
        if !baseline { XCTAssertFalse(jump.exists, "Jump to latest resumes following") }
        app.terminate()
    }

    func testReconnectNoticeHasStableGeometryAndDraftCopy() {
        let app = launch(["-refreshReconnect"])
        let note = app.descendants(matching: .any)["newChat.offlineNote"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        let before = note.frame
        attach(app, "reconnect-notice")
        Thread.sleep(forTimeInterval: 1.2)
        if !baseline {
            let title = app.descendants(matching: .any)["reconnect.title"].firstMatch
            if !title.exists {
                let hierarchy = XCTAttachment(string: app.debugDescription)
                hierarchy.name = "reconnect-accessibility-hierarchy"
                hierarchy.lifetime = .keepAlways
                add(hierarchy)
                print("RECONNECT_ACCESSIBILITY \(app.debugDescription)")
            }
            XCTAssertTrue(title.exists)
            XCTAssertEqual(title.label, "Gomi is reconnecting...")
            XCTAssertTrue(app.staticTexts["Draft your message now and it will send when Gomi reconnects"].exists)
            XCTAssertEqual(note.frame.width, before.width, accuracy: 0.5)
            XCTAssertEqual(note.frame.height, before.height, accuracy: 0.5)
        }
        attach(app, "reconnect-dots-later")
        app.terminate()
    }
}
