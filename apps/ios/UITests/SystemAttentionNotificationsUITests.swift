import XCTest

/// Real OS surfaces, only on an explicitly opted-in disposable CI simulator.
/// Same harness/data on the exact base; baseline never receives a badge writer.
@MainActor
final class SystemAttentionNotificationsUITests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private var baseline: Bool { ProcessInfo.processInfo.environment["NEKKO_ATTENTION_BASELINE"] == "1" }

    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "system-attention-" + name
        shot.lifetime = .keepAlways
        add(shot)
        let tree = XCTAttachment(string: springboard.debugDescription)
        tree.name = "springboard-" + name
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func reading(_ app: XCUIApplication, contains value: String) {
        let row = app.staticTexts["system-attention-reading"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let predicate = NSPredicate(format: "label CONTAINS %@", value)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: row)], timeout: 10), .completed, value)
        let text = XCTAttachment(string: row.label)
        text.name = "os-readback-" + value
        text.lifetime = .keepAlways
        add(text)
    }

    private func homeBadge(_ expected: Int, phase: String) {
        XCUIDevice.shared.press(.home)
        // A second Home returns to the first page, including from App Library.
        // SpringBoard exposes duplicate off-page icons; firstMatch can select a
        // hidden Home icon while the Library's 68pt unlabeled tile is visible.
        XCUIDevice.shared.press(.home)
        let candidates = springboard.icons.matching(identifier: "Nekko Agent")
        // Filter by geometry only: isHittable on an off-page icon throws (no valid activation point).
        let screen = springboard.frame
        let onHome: (XCUIElement) -> Bool = { $0.frame.height > 80 && screen.contains($0.frame) }
        let visibleHome = NSPredicate { _, _ in candidates.allElementsBoundByIndex.contains(where: onHome) }
        for page in 0..<3 {
            if XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: visibleHome, object: nil)], timeout: 3) == .completed { break }
            if page < 2 { springboard.swipeLeft() }
        }
        guard let icon = candidates.allElementsBoundByIndex.first(where: onHome) else {
            capture("home-navigation-failed-" + phase)
            XCTFail("Evidence must show the labeled Home Screen icon, not App Library or an off-page AX element: \(springboard.debugDescription)")
            return
        }
        XCTAssertTrue(screen.contains(icon.frame), "Icon on the visible Home page")
        XCTAssertGreaterThan(icon.frame.height, 80, "Home icon with its label; not the 68pt App Library tile")
        let badge = NSPredicate { element, _ in
            guard let icon = element as? XCUIElement else { return false }
            let value = icon.value as? String ?? ""
            if expected == 0 { return value.isEmpty || value == "0" }
            return value.range(of: "\\b\(expected)\\b", options: .regularExpression) != nil
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: badge, object: icon)], timeout: 10)
        capture("home-" + phase)
        XCTAssertEqual(result, .completed, "Expected SpringBoard badge \(expected), actual AX value: \(String(describing: icon.value))")
    }

    func testRealPermissionDeliveryCategoryAndHomeBadgeLifecycle() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["NEKKO_SYSTEM_ATTENTION_EVIDENCE"] == "1",
                          "System permissions and Home belong only to disposable evidence simulators")
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestSystemAttentionNotifications", "-splash", "NO"]
        app.launch()
        XCTAssertTrue(app.navigationBars["System attention fixture"].waitForExistence(timeout: 10))
        app.buttons["Grant notification permission"].tap()
        let allow = springboard.alerts.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10), "A fresh disposable simulator must show the real authorization prompt")
        capture("permission-prompt")
        allow.tap()
        reading(app, contains: "authorization=authorized badges=enabled")
        reading(app, contains: "pending=0 osBadge=0")
        homeBadge(0, phase: "initial-zero")
        app.activate()

        app.buttons["Post foreground approval"].tap()
        let banner = springboard.staticTexts["A tool needs your approval."].firstMatch
        if baseline {
            XCTAssertFalse(banner.waitForExistence(timeout: 3), "Old foreground implementation must remain unchanged")
        } else {
            XCTAssertTrue(banner.waitForExistence(timeout: 10), springboard.debugDescription)
        }
        capture("foreground-approval")
        reading(app, contains: "pending=2 osBadge=\(baseline ? 0 : 2)")
        if !baseline {
            reading(app, contains: "delivered=1 approval=true actions=true local=true payloadBadge=false")
        }
        homeBadge(baseline ? 0 : 2, phase: "two-pending")
        app.activate()
        app.buttons["Answer active approval"].tap()
        reading(app, contains: "pending=1 osBadge=\(baseline ? 0 : 1)")
        homeBadge(baseline ? 0 : 1, phase: "one-pending")
        app.activate()
        app.buttons["Remote dismiss fleet question"].tap()
        reading(app, contains: "pending=0 osBadge=0")
        homeBadge(0, phase: "resolved-zero")
        app.activate()

        // Both revisions must deliver a real background approval. This proves
        // category/payload via the OS query and the OS surface, not a recorder.
        app.buttons["Clear delivered notifications"].tap()
        reading(app, contains: "delivered=0")
        app.buttons["Post approval from Home"].tap()
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(banner.waitForExistence(timeout: 10), springboard.debugDescription)
        capture("background-approval-banner")
        // Notification Center retains the real delivered notification after
        // its transient banner. Capture the same system route on both revisions.
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01))
            .press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)))
        XCTAssertTrue(springboard.staticTexts["A tool needs your approval."].firstMatch.waitForExistence(timeout: 10))
        capture("notification-center-approval")
        XCUIDevice.shared.press(.home)
        app.activate()
        reading(app, contains: "pending=2 osBadge=\(baseline ? 0 : 2)")
        reading(app, contains: "delivered=1 approval=true actions=true local=true payloadBadge=false")
        app.buttons["Answer active approval"].tap()
        app.buttons["Remote dismiss fleet question"].tap()
        reading(app, contains: "pending=0 osBadge=0 delivered=0")
        homeBadge(0, phase: "cleanup-zero")
        app.terminate()
    }
}
