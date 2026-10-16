import XCTest

extension XCTestCase {
    /// iOS 17's accessibility audit (labels, contrast, hit regions, Dynamic Type
    /// clipping, traits) on whatever `app` shows now. Every issue is collected
    /// into one attachment and the test fails listing all of them, so a single
    /// run shows the whole picture instead of stopping at the first finding.
    func auditAccessibility(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        var issues: [String] = []
        do {
            try app.performAccessibilityAudit { issue in
                let element = issue.element.map { e in
                    let label = e.label.isEmpty ? e.identifier : e.label
                    return "\(e.elementType.rawValue) \"\(label)\""
                } ?? "(no element)"
                issues.append("\(issue.auditType): \(issue.compactDescription) — \(element)")
                return true // keep going; reported below
            }
        } catch {
            issues.append("audit did not run: \(error)")
        }
        let report = XCTAttachment(string: issues.isEmpty ? "no issues" : issues.joined(separator: "\n"))
        report.name = "a11y-\(screen)"
        report.lifetime = .keepAlways
        add(report)
        if !issues.isEmpty {
            XCTFail("Accessibility audit, \(screen): \(issues.count) issue(s)\n" + issues.joined(separator: "\n"), file: file, line: line)
        }
    }
}
