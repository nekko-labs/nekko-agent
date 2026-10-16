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
    /// - Elements not fully on screen (under the keyboard or scrolled away),
    ///   or covered by other UI (not hittable), for contrast and clipping:
    ///   the audit samples whatever covers them.
    /// - Clipping on the system search field's placeholder.
    /// - Findings the audit can't attach to an element.
    func auditAccessibility(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        let done = app.buttons["keyboard.done"]
        if app.keyboards.firstMatch.exists, done.exists { done.tap() }
        let deadline = Date().addingTimeInterval(2)
        while app.keyboards.firstMatch.exists, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        let window = app.windows.firstMatch.frame

        var blocking: [String] = [], other: [String] = []
        do {
            try app.performAccessibilityAudit { issue in
                let line = "\(Self.name(issue.auditType)): \(issue.compactDescription) — \(Self.describe(issue.element))"
                if Self.blocks(issue, in: window) { blocking.append(line) } else { other.append(line) }
                return true // handled here; reported below
            }
        } catch {
            blocking.append("audit did not run: \(error)")
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

    private static func blocks(_ issue: XCUIAccessibilityAuditIssue, in window: CGRect) -> Bool {
        if issue.auditType == .dynamicType { return false }
        // The audit names no element for some findings: nothing to act on, but listed.
        guard let e = issue.element, e.exists else { return false }
        if !e.isEnabled { return false }
        if !window.isEmpty, !window.contains(e.frame) { return false }
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
