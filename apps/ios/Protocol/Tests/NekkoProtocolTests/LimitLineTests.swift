import XCTest
@testable import NekkoProtocol

final class LimitLineTests: XCTestCase {
    private func limits(_ windows: [(String, Double, String)]) -> ProviderLimits? {
        let list: [JSONValue] = windows.map { w in
            .object(["id": .string(w.0), "label": .string(w.0), "usedPercent": .double(w.1), "status": .string(w.2)])
        }
        return ProviderLimits.from(.object(["windows": .array(list)]))
    }

    func testNoWindowsMeansNoLine() {
        XCTAssertNil(LimitLine.tightest(nil))
        XCTAssertNil(LimitLine.tightest(limits([])))
    }

    func testTheTightestWindowWins() {
        let line = LimitLine.tightest(limits([("5-hour", 34, "allowed"), ("Weekly", 61, "allowed")]))
        XCTAssertEqual(line?.window.id, "Weekly")
        XCTAssertEqual(line?.percent, 61)
        XCTAssertEqual(line?.level, .quiet)
    }

    func testALimitedWindowWinsOverAFullerOne() {
        let line = LimitLine.tightest(limits([("5-hour", 99, "allowed"), ("Weekly", 40, "rate_limited")]))
        XCTAssertEqual(line?.window.id, "Weekly")
        XCTAssertEqual(line?.level, .reached)
    }

    func testLevels() {
        XCTAssertEqual(LimitLine.tightest(limits([("a", 74.4, "allowed")]))?.level, .quiet)
        XCTAssertEqual(LimitLine.tightest(limits([("a", 75, "allowed")]))?.level, .near)
        XCTAssertEqual(LimitLine.tightest(limits([("a", 20, "warning")]))?.level, .near)
        XCTAssertEqual(LimitLine.tightest(limits([("a", 100, "allowed")]))?.level, .reached)
    }
}
