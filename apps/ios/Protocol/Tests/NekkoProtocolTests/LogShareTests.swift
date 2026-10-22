import Foundation
import XCTest
@testable import NekkoProtocol

/// The log share button's redaction, held to the computer's cases
/// (`Fixtures/log-redact.json`, a copy of `crates/nekkod/tests/golden/log-redact.json`).
final class LogShareTests: XCTestCase {
    func fixture() throws -> JSONValue {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "log-redact", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONValue.parse(Data(contentsOf: url))
    }

    func testRedactsLikeTheComputer() throws {
        let f = try fixture()
        for c in try XCTUnwrap(f["cases"]?.array) {
            let pair = try XCTUnwrap(c.array)
            let input = try XCTUnwrap(pair[0].string)
            XCTAssertEqual(LogShare.redact(input), pair[1].string, input)
        }
        for k in try XCTUnwrap(f["keep"]?.array) {
            let line = try XCTUnwrap(k.string)
            XCTAssertEqual(LogShare.redact(line), line)
        }
    }

    func testSharesTheTailRedactedWithAHeader() {
        let log = LogText(id: "daemon", size: 100, truncated: true, text: "started\nOPENAI_API_KEY=sk-proj-abcdefghijklmnop1234\n",
                          query: nil, matches: [], moreMatches: false)
        let text = LogShare.text(title: "Engine", log: log, at: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(text, """
            Nekko Agent log: Engine
            Shared: 1970-01-01T00:00:00Z
            Secrets were removed on the computer and again on this iPhone. Check before you send it on.

            (older lines are on the computer)
            started
            OPENAI_API_KEY=[redacted]
            """)
    }

    func testSharesSearchMatchesWithLineNumbers() {
        let log = LogText(id: "app", size: 10, truncated: false, text: nil, query: "token",
                          matches: [.init(line: 12, text: "token ghp_abcdefghijklmnopqrstuvwxyz0123 ok"), .init(line: 40, text: "fine")],
                          moreMatches: true)
        let lines = LogShare.text(title: "App", log: log).components(separatedBy: "\n")
        XCTAssertEqual(Array(lines.suffix(4)), ["Lines matching \"token\":", "12: token [redacted] ok", "40: fine", "(more lines match)"])
    }
}
