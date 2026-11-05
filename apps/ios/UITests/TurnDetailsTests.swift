import XCTest

@MainActor
final class TurnDetailsTests: XCTestCase {
    private func launch(_ extra: [String] = [], theme: String = "light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestTurnDetails", "-splash", "NO", "-appLock", "NO", "-onboarded", "YES",
                               "-theme", theme, "-expertMode", "NO", "-simpleChoices", "{}"] + extra
        app.launch()
        return app
    }

    private func footer(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "turn.details.measured").firstMatch
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Safe to run with just this fixture + registration + test copied onto the
    /// exact base revision: it makes no claim that the footer already exists.
    /// Label the artifact before/after only after checking the source revision.
    func testCaptureFixture() {
        let app = launch()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The focused tests pass")).firstMatch.waitForExistence(timeout: 10))
        capture(app, "turn-details-fixture")
    }

    func testCompletedReplyShowsActualModelEffortCountsRateAndDone() {
        let app = launch()
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        XCTAssertTrue(details.label.hasPrefix("Done."))
        for text in ["used-model", "used-provider", "High effort", "1.3k in", "500 out", "50 tok/s", "50s"] {
            XCTAssertTrue(details.label.contains(text), text)
        }
        XCTAssertFalse(details.label.contains("selected-model"))
        XCTAssertFalse(details.label.contains("Low effort"))
        XCTAssertTrue(details.isHittable)
        capture(app, "turn-details-complete-light")
    }

    func testInterruptedAndLoopRepliesNeverShowSuccess() {
        for flag in ["-turnDetailsInterrupted", "-turnDetailsLoop"] {
            let app = launch([flag])
            let details = footer(app)
            XCTAssertTrue(details.waitForExistence(timeout: 10))
            XCTAssertFalse(details.label.hasPrefix("Done."))
            XCTAssertTrue(details.label.contains("500 out"))
            capture(app, "turn-details" + flag)
            app.terminate()
        }
    }

    func testUntimedToolOnlyTurnKeepsDetailsWhenStepsAreFolded() {
        let app = launch(["-turnDetailsToolOnly", "-turnDetailsUntimed"], theme: "dark")
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        XCTAssertTrue(details.label.hasPrefix("Done."))
        XCTAssertTrue(details.label.contains("500 out"))
        XCTAssertFalse(details.label.contains("tok/s"), "wall time must not become decode speed")
        XCTAssertTrue(details.isHittable)
        capture(app, "turn-details-tool-only-untimed-dark")
    }

    func testLegacyReplyHasNoInventedMetricsOrSuccess() {
        let app = launch(["-turnDetailsLegacy"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The focused tests pass")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(footer(app).exists)
        capture(app, "turn-details-legacy")
    }

    private struct LayoutReading: Decodable {
        let frames: [String: [Double]]
        let lines: [[Double]]
        let truncated: Bool
        let dynamicType: String
        let scale: Double

        func frame(_ name: String) throws -> CGRect {
            let r = try XCTUnwrap(frames[name], name)
            XCTAssertEqual(r.count, 4)
            return CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
        }
    }

    private func reading(_ app: XCUIApplication, name: String, rendered: Bool) throws -> LayoutReading {
        let element = app.descendants(matching: .any).matching(identifier: "turn.details.layout").firstMatch
        let ready = NSPredicate { _, _ in
            guard let value = element.value as? String, let data = value.data(using: .utf8),
                  let result = try? JSONDecoder().decode(LayoutReading.self, from: data) else { return false }
            return result.frames["metrics"] != nil && result.frames["footer"] != nil
                && result.frames["transcript"] != nil && (!rendered || !result.lines.isEmpty)
        }
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: nil)], timeout: 10), .completed)
        let value = try XCTUnwrap(element.value as? String)
        let ax = footer(app).frame
        let text = value + "\nXCUI combined frame: " + String(describing: ax)
        print("TURN_DETAILS_LAYOUT \(name): \(text)")
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        return try JSONDecoder().decode(LayoutReading.self, from: Data(value.utf8))
    }

    private func assertContentBounds(_ result: LayoutReading, app: XCUIApplication) throws {
        let box = try result.frame("footer")
        let metrics = try result.frame("metrics")
        let transcript = try result.frame("transcript")
        XCTAssertGreaterThan(box.width, 0)
        XCTAssertGreaterThan(metrics.height, 0)
        // Keep the real 16pt transcript gutter. No epsilon and no expanded bounds.
        XCTAssertGreaterThanOrEqual(box.minX, app.frame.minX + 16)
        XCTAssertLessThanOrEqual(box.maxX, app.frame.maxX - 16)
        XCTAssertGreaterThanOrEqual(box.minY, transcript.minY)
        XCTAssertLessThanOrEqual(box.maxY, transcript.maxY)
        XCTAssertGreaterThanOrEqual(metrics.minX, box.minX)
        XCTAssertLessThanOrEqual(metrics.maxX, box.maxX)
        XCTAssertGreaterThanOrEqual(metrics.minY, box.minY)
        XCTAssertLessThanOrEqual(metrics.maxY, box.maxY)
    }

    func testDetailsWrapAtLargestDynamicType() throws {
        let measure = ["-turnDetailsMeasureLayout"]
        let render = ["-turnDetailsRenderLayout"]
        let largest = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        let normalApp = launch(measure + render)
        let normal = try reading(normalApp, name: "layout-default-rendered", rendered: true)
        normalApp.terminate()

        // First measure the unchanged selectable Text without a custom renderer.
        let app = launch(measure + largest)
        let details = footer(app)
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        if !details.isHittable { app.swipeUp() }
        XCTAssertTrue(details.isHittable)
        XCTAssertTrue(details.label.contains("50 tok/s"))
        let original = try reading(app, name: "layout-xxxl-selectable", rendered: false)
        try assertContentBounds(original, app: app)
        XCTAssertEqual(original.dynamicType, "accessibility5")
        capture(app, "turn-details-accessibility-xxxl")
        app.terminate()

        // A pass-through renderer gives actual laid-out lines, not an AX union
        // or a hidden duplicate Text. It must preserve the original geometry.
        let renderedApp = launch(measure + render + largest)
        let rendered = try reading(renderedApp, name: "layout-xxxl-rendered", rendered: true)
        try assertContentBounds(rendered, app: renderedApp)
        XCTAssertEqual(try rendered.frame("metrics").size, try original.frame("metrics").size)
        XCTAssertEqual(try rendered.frame("footer").size, try original.frame("footer").size)
        XCTAssertEqual(rendered.dynamicType, "accessibility5")
        XCTAssertFalse(rendered.truncated)
        XCTAssertGreaterThan(rendered.lines.count, 1, "the actual metric text must wrap")
        let first = try XCTUnwrap(rendered.lines.first)
        let defaultFirst = try XCTUnwrap(normal.lines.first)
        XCTAssertGreaterThan(first[3], defaultFirst[3], "the font must really scale, not just the launch flag")
        let size = try rendered.frame("metrics").size
        for line in rendered.lines {
            XCTAssertEqual(line.count, 4)
            XCTAssertGreaterThan(line[2], 0)
            XCTAssertGreaterThan(line[3], 0)
            XCTAssertGreaterThanOrEqual(line[0], 0)
            XCTAssertGreaterThanOrEqual(line[1], 0)
            XCTAssertLessThanOrEqual(line[0] + line[2], size.width)
            XCTAssertLessThanOrEqual(line[1] + line[3], size.height)
        }
        renderedApp.terminate()

        // Diagnostic control only: selection stays enabled in the shipped view.
        // Comparing this AX frame isolates selection-related accessibility inflation.
        let noSelectionApp = launch(measure + largest + ["-turnDetailsNoSelection"])
        let noSelection = try reading(noSelectionApp, name: "layout-xxxl-no-selection-control", rendered: false)
        XCTAssertEqual(try noSelection.frame("metrics").size, try original.frame("metrics").size)
        try assertContentBounds(noSelection, app: noSelectionApp)
    }
}
