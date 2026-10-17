import XCTest

extension XCTestCase {
    /// iOS 17's accessibility audit (labels, contrast, hit regions, clipping,
    /// traits) on whatever `app` shows now. Every finding is collected into one
    /// attachment and the test fails listing all blocking ones, so a run shows
    /// the whole picture instead of stopping at the first.
    ///
    /// Not blocking, but still listed in the attachment:
    /// - Dynamic Type "partially unsupported": the views use text styles, and
    ///   `FirstRunTests.testLargestTextSizesStillFit` drives the real accessibility-XL
    ///   layout instead; the audit's heuristic flags SwiftUI text that does scale.
    /// - Anything on a disabled control (WCAG 1.4.3 exempts inactive components).
    /// - Elements not fully on screen (scrolled away, or under a keyboard that stayed up),
    ///   or covered by other UI (not hittable), for contrast and clipping:
    ///   the audit samples whatever covers them.
    /// - Clipping on the system search field's placeholder.
    /// - Findings the audit can't attach to an element.
    /// `ignoring`: element labels excluded on this screen, each with its reason at the call site.
    /// `covered`: a pinned, translucent bar; text under it is measured against the
    /// bar, so its contrast and clipping findings are listed but don't block.
    func auditAccessibility(_ app: XCUIApplication, _ screen: String, ignoring: Set<String> = [], covered: CGRect = .null,
                            file: StaticString = #filePath, line: UInt = #line) {
        let done = app.buttons["keyboard.done"]
        if app.keyboards.firstMatch.exists, done.exists { done.tap() }
        let deadline = Date().addingTimeInterval(2)
        while app.keyboards.firstMatch.exists, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        // The keyboard going away moves the bottom bar and re-lays out the screen;
        // auditing mid-animation reported rows as clipped or covered.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        let window = app.windows.firstMatch.frame
        // If the keyboard is still up, what's under it (and its Done bar) isn't what the user sees.
        let keyboard = app.keyboards.firstMatch.exists ? app.keyboards.firstMatch.frame.insetBy(dx: 0, dy: -44) : .null

        var blocking: [String] = [], other: [String] = []
        // XCTest's audit sometimes times out on a busy simulator (code -56): one retry.
        for attempt in 1...2 {
            blocking = []
            other = []
            do {
                try app.performAccessibilityAudit { issue in
                    let line = "\(Self.name(issue.auditType)): \(issue.compactDescription) — \(Self.describe(issue.element))"
                    let ignored = issue.element.map { ignoring.contains($0.label) } ?? false
                    if !ignored, Self.blocks(issue, in: window, keyboard: keyboard, covered: covered) { blocking.append(line) } else { other.append(line) }
                    return true // handled here; reported below
                }
                break
            } catch let e as NSError where e.code == -56 && attempt == 1 {
                continue
            } catch {
                blocking.append("audit did not run: \(error)")
                break
            }
        }
        let text = (["blocking: \(blocking.count)"] + blocking + ["", "not blocking: \(other.count)"] + other).joined(separator: "\n")
        let report = XCTAttachment(string: text)
        report.name = "a11y-\(screen)"
        report.lifetime = .keepAlways
        add(report)
        if !blocking.isEmpty {
            XCTFail("Accessibility audit, \(screen): \(blocking.count) issue(s)\n" + blocking.joined(separator: "\n"), file: file, line: line)
        }
    }

    private static func blocks(_ issue: XCUIAccessibilityAuditIssue, in window: CGRect, keyboard: CGRect, covered: CGRect) -> Bool {
        if issue.auditType == .dynamicType { return false }
        // The audit names no element for some findings: nothing to act on, but listed.
        guard let e = issue.element, e.exists else { return false }
        if !e.isEnabled { return false }
        if !window.isEmpty, !window.contains(e.frame) { return false }
        if !keyboard.isNull, e.frame.intersects(keyboard) { return false }
        if !covered.isNull, issue.auditType == .contrast || issue.auditType == .textClipped, e.frame.intersects(covered) { return false }
        // Covered by other UI (a pinned bar, a card over the transcript): the
        // audit samples whatever is on top, not the element's own colours.
        if issue.auditType == .contrast || issue.auditType == .textClipped, !e.isHittable { return false }
        if issue.auditType == .textClipped, e.elementType == .searchField { return false }
        return true
    }

    private static func describe(_ element: XCUIElement?) -> String {
        guard let e = element, e.exists else { return "(no element)" }
        let label = e.label.isEmpty ? e.identifier : e.label
        return "\(e.elementType.rawValue) \"\(label)\" \(NSCoder.string(for: e.frame))"
    }

    private static func name(_ type: XCUIAccessibilityAuditType) -> String {
        switch type {
        case .contrast: return "contrast"
        case .dynamicType: return "dynamicType"
        case .textClipped: return "textClipped"
        case .elementDetection: return "elementDetection"
        case .hitRegion: return "hitRegion"
        case .sufficientElementDescription: return "description"
        case .trait: return "trait"
        default: return "type \(type.rawValue)"
        }
    }
}
