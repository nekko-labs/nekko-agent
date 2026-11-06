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

    /// Canonicalize only floating-point arithmetic residue at integer physical
    /// pixel coordinates, never a visual tolerance. At 48px this permits ~6e-14px,
    /// not a fraction of a pixel. Raw measurements remain attached unchanged.
    private func physicalCoordinate(_ points: Double, scale: Double) -> Double {
        let pixels = points * scale
        let integer = pixels.rounded()
        return abs(pixels - integer) <= max(pixels.ulp, integer.ulp) * 8 ? integer : pixels
    }

    func testCoordinateNormalizationRejectsPhysicalOverflow() {
        for scale in [2.0, 3.0] {
            let boundary = 16.0 * scale
            XCTAssertEqual(physicalCoordinate(15.999999999999982, scale: scale), boundary)
            for shortfall in [0.25, 0.5, 1.0] {
                XCTAssertLessThan(physicalCoordinate(16 - shortfall / scale, scale: scale), boundary)
                XCTAssertGreaterThan(physicalCoordinate(386 + shortfall / scale, scale: scale), 386 * scale)
            }
        }
    }

    private func assertContentBounds(_ result: LayoutReading, app: XCUIApplication) throws {
        let box = try result.frame("footer")
        let metrics = try result.frame("metrics")
        XCTAssertGreaterThan(box.width, 0)
        XCTAssertGreaterThan(metrics.height, 0)
        // Keep strict 16pt gutters in physical coordinates, stripping only ULP
        // residue demonstrated by native readings (15.999999999999982pt).
        XCTAssertGreaterThan(result.scale, 0)
        XCTAssertGreaterThanOrEqual(physicalCoordinate(box.minX, scale: result.scale),
                                    physicalCoordinate(app.frame.minX + 16, scale: result.scale))
        XCTAssertLessThanOrEqual(physicalCoordinate(box.maxX, scale: result.scale),
                                physicalCoordinate(app.frame.maxX - 16, scale: result.scale))
        // At accessibility5 the footer is taller than the transcript viewport.
        // Vertical reachability is checked by scrolling each end below.
        XCTAssertGreaterThanOrEqual(metrics.minX, box.minX)
        XCTAssertLessThanOrEqual(metrics.maxX, box.maxX)
        XCTAssertGreaterThanOrEqual(metrics.minY, box.minY)
        XCTAssertLessThanOrEqual(metrics.maxY, box.maxY)
    }

    /// Exercise the real selectable Text, using line rectangles measured by the
    /// equal-size renderer control. A tall footer need not fit all at once, but
    /// the entire first and last metric lines must be reachable inside the clip.
    private func revealLine(_ local: [Double], app: XCUIApplication, name: String) throws -> LayoutReading {
        var result = try reading(app, name: name + "-start", rendered: false)
        for attempt in 0..<12 {
            let text = try result.frame("metrics")
            let viewport = try result.frame("transcript").intersection(app.frame)
            let line = CGRect(x: text.minX + local[0], y: text.minY + local[1], width: local[2], height: local[3])
            if line.minY >= viewport.minY && line.maxY <= viewport.maxY {
                try assertContentBounds(result, app: app)
                capture(app, name)
                return result
            }
            // Drag only in the transcript's trailing gutter, never the composer
            // or selectable text. Bounded short drags avoid fling/overscroll.
            let delta = min(viewport.height * 0.35, max(-viewport.height * 0.35, viewport.midY - line.midY))
            let start = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: viewport.maxX - 8, dy: viewport.midY))
            let end = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: viewport.maxX - 8, dy: viewport.midY + delta))
            // The default drag velocity flung ~250pt for a ~52pt gesture in
            // the measured 148pt viewport, oscillating past the target line.
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
            result = try reading(app, name: name + "-scroll-\(attempt)", rendered: false)
        }
        XCTFail("The full \(name) metric line was not reachable in the actual transcript viewport")
        return result
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
        let textFrame = try rendered.frame("metrics")
        let footerFrame = try rendered.frame("footer")
        for line in rendered.lines {
            XCTAssertEqual(line.count, 4)
            XCTAssertGreaterThan(line[2], 0)
            XCTAssertGreaterThan(line[3], 0)
            XCTAssertGreaterThanOrEqual(line[0], 0)
            XCTAssertLessThanOrEqual(line[0] + line[2], textFrame.width)
            // Typographic ascent can extend fractionally above Text's origin
            // (measured -0.0859375pt), but must stay inside the real footer.
            // No glyphs or lines are clipped at that Text origin.
            XCTAssertGreaterThanOrEqual(textFrame.minY + line[1], footerFrame.minY)
            XCTAssertLessThanOrEqual(textFrame.minY + line[1] + line[3], footerFrame.maxY)
        }
        renderedApp.terminate()

        let scrollApp = launch(measure + largest)
        let top = try revealLine(first, app: scrollApp, name: "turn-details-xxxl-first-line")
        let last = try XCTUnwrap(rendered.lines.last)
        let bottom = try revealLine(last, app: scrollApp, name: "turn-details-xxxl-last-line")
        XCTAssertEqual(try top.frame("metrics").size, textFrame.size)
        XCTAssertEqual(try bottom.frame("metrics").size, textFrame.size)
        // Prove the successful endpoint checks did not simply read the same
        // clipped position twice when the content is taller than the viewport.
        XCTAssertNotEqual(try top.frame("metrics").minY, try bottom.frame("metrics").minY)
        scrollApp.terminate()

        // Diagnostic control only: selection stays enabled in the shipped view.
        // Comparing this AX frame isolates selection-related accessibility inflation.
        let noSelectionApp = launch(measure + largest + ["-turnDetailsNoSelection"])
        let noSelection = try reading(noSelectionApp, name: "layout-xxxl-no-selection-control", rendered: false)
        XCTAssertEqual(try noSelection.frame("metrics").size, try original.frame("metrics").size)
        try assertContentBounds(noSelection, app: noSelectionApp)
    }
}
