import Foundation
import XCTest
@testable import NekkoProtocol

/// `monitor:summary` as the computer's phone gate answers it in the golden set
/// (crates/nekko-remote/tests/golden/phone.json, written by FD-1), and the
/// shapes a computer may send around it.
final class MonitorSummaryTests: XCTestCase {
    func golden() throws -> [JSONValue] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("crates/nekko-remote/tests/golden/phone.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("repository sources not available at \(file.path)") }
        return try XCTUnwrap(JSONValue.parse(data)["cases"]?.array)
    }

    func testDecodesTheGoldenMonitorSummary() throws {
        let cases = try golden().filter { $0.str("channel") == Channels.monitorSummary && $0["error"] == nil }
        XCTAssertGreaterThanOrEqual(cases.count, 1)
        for c in cases {
            let m = try XCTUnwrap(MonitorSummary.from(c["result"]))
            XCTAssertEqual(m.hardware.cpu.loadPct, 42.5)
            XCTAssertEqual(m.hardware.cpu.cores, 16)
            XCTAssertEqual(m.hardware.cpu.tempC, 71)
            XCTAssertEqual(m.hardware.memory.usedMB, 20000)
            XCTAssertEqual(m.hardware.memory.totalMB, 65536)
            XCTAssertEqual(m.hardware.memory.tempC, 48)
            let gpu = try XCTUnwrap(m.hardware.gpu)
            XCTAssertEqual(gpu.loadPct, 87)
            XCTAssertEqual(gpu.tempC, 70)
            XCTAssertEqual(gpu.memoryUsedMB, 9100)
            XCTAssertEqual(gpu.memoryTotalMB, 36852)
            XCTAssertFalse(gpu.unified)

            XCTAssertEqual(m.running.map(\.id), ["s1", "s2", "gone"])
            XCTAssertEqual(m.running.map(\.step), [.approval, .working, .working])
            XCTAssertEqual(m.running[0].elapsedMs, 0, "a start ahead of the computer's clock reads 0")
            XCTAssertNil(m.running[1].elapsedMs)
            XCTAssertEqual(m.running[1].title.utf16.count, 120, "titles are cut to 120 UTF-16 units on the computer")
            XCTAssertEqual(m.running[2].title, "")

            XCTAssertEqual(m.needsYou.map(\.kind), [.question, .approval], "oldest first")
            XCTAssertEqual(m.needsYou[0].sessionId, "s3")
            XCTAssertEqual(m.needsYou[0].callId, "q1")
            XCTAssertEqual(m.needsYou[0].label, "Which auth method?")
            XCTAssertEqual(m.needsYou[0].count, 1)
            XCTAssertNil(m.needsYou[0].risk)
            XCTAssertEqual(m.needsYou[1].risk, .high)
            XCTAssertEqual(m.needsYou[1].label, "bash")
            XCTAssertEqual(m.needsYou[1].since, 500)
            XCTAssertNotEqual(m.needsYou[0].id, m.needsYou[1].id)

            XCTAssertEqual(m.automations.map(\.id), ["task/t1", "workflow/w1"])
            XCTAssertEqual(m.automations.map(\.name), ["Nightly", "Review PRs"])
            XCTAssertEqual(m.automations.map(\.nextRunAt), [3, 4])
        }
    }

    func testAComputerWithoutAGpuAndPartialRows() throws {
        let raw = try JSONValue.parse("""
        {"hardware":{"cpu":{"loadPct":0,"cores":0},"memory":{"usedMB":0,"totalMB":0},"gpu":null},
         "running":[{"id":"a","title":"A","step":"later"},{"title":"no id"}],
         "needsYou":[{"sessionId":"a","kind":"approval","callId":"c1","label":"edit"},{"sessionId":"b","kind":"other","callId":"x"}],
         "automations":[{"kind":"task","id":"t","name":"T"},{"kind":"workflow","id":"w","name":"W","nextRunAt":9}]}
        """)
        let m = try XCTUnwrap(MonitorSummary.from(raw))
        XCTAssertNil(m.hardware.gpu)
        XCTAssertNil(m.hardware.cpu.tempC)
        XCTAssertNil(m.hardware.memory.fraction, "no total, no gauge")
        XCTAssertEqual(m.running.map(\.id), ["a"])
        XCTAssertEqual(m.running[0].step, .working, "an unknown step reads as working")
        XCTAssertEqual(m.needsYou.map(\.callId), ["c1"])
        XCTAssertEqual(m.needsYou[0].risk, .medium, "an approval without a risk is medium, as the computer defaults it")
        XCTAssertEqual(m.automations.map(\.automationId), ["w"], "an automation without a next run is left out")
    }

    func testAnythingButAnObjectIsNoSummary() throws {
        XCTAssertNil(MonitorSummary.from(nil))
        XCTAssertNil(MonitorSummary.from(.string("no")))
        let empty = try XCTUnwrap(MonitorSummary.from(.object([:])))
        XCTAssertTrue(empty.running.isEmpty && empty.needsYou.isEmpty && empty.automations.isEmpty)
        XCTAssertNil(empty.hardware.cpu.loadPct)
    }

    func testMemoryAndGpuFractionsStayInRange() throws {
        let raw = try JSONValue.parse(#"{"hardware":{"cpu":{},"memory":{"usedMB":70000,"totalMB":65536},"gpu":{"memoryUsedMB":10,"memoryTotalMB":40,"unified":true}}}"#)
        let m = try XCTUnwrap(MonitorSummary.from(raw))
        XCTAssertEqual(m.hardware.memory.fraction, 1)
        XCTAssertEqual(m.hardware.gpu?.memoryFraction, 0.25)
        XCTAssertEqual(m.hardware.gpu?.unified, true)
    }
}
