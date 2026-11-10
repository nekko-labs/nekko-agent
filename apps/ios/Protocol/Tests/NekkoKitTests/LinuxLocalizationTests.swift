#if os(Linux)
import XCTest
import NekkoProtocol
import NekkoKit

final class LinuxLocalizationTests: XCTestCase {
    func testLiteralSourceTextIsUnchanged() {
        XCTAssertEqual(String(localized: "The provider listed no models."), "The provider listed no models.")
        XCTAssertEqual(String(localized: ""), "")
        XCTAssertEqual(String(localized: "This service can’t be connected on the iPhone."), "This service can’t be connected on the iPhone.")
    }

    func testInterpolationPreservesValuesAndUnicode() {
        let name = "作業 Mac"
        let count = 3
        XCTAssertEqual(String(localized: "on \(name) (phone)"), "on 作業 Mac (phone)")
        XCTAssertEqual(String(localized: "\(count) recipients"), "3 recipients")
    }

    func testImportedInitializerAlsoSupportsRuntimeStrings() {
        let source = ["Paste", "the token."].joined(separator: " ")
        XCTAssertEqual(String(localized: source), source)
    }
}
#endif
