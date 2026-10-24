import XCTest
@testable import NekkoKit
import NekkoProtocol

/// A computer's page: the summary as the computer sends it, and the round trips the phone keeps.
final class MachineModelTests: XCTestCase {
    func testDecodesAMachineSummary() throws {
        let raw = try JSONValue.parse("""
        {"version":"0.9.3","platform":"darwin","edition":"desktop","uptimeMs":273600000,
         "hardware":{"platform":"darwin","arch":"arm64","release":"25.1.0","cpu":{"model":"Apple M4 Max","cores":16},"ramBytes":137438953472,
                     "unified":true,"gpus":[{"name":"Apple M4 Max","vramBytes":137438953472,"cores":40}],"backends":["metal","cpu"],
                     "engine":{"backend":"metal","version":"b7000"},"diskFreeBytes":1000000000000},
         "live":{"cpuPct":12.5,"cpuCores":16,"memUsedMB":61000,"memTotalMB":131072,"temps":{"cpuC":48,"gpuC":51}},
         "gpu":{"source":"macos","devices":[{"name":"Apple M4 Max","memoryTotalMB":131072,"memoryUsedMB":15000,"temperatureC":55}],"unified":true,"totalMB":131072,"usedMB":15000,"freeMB":116072},
         "engine":{"running":true,"startedAt":1000,"resident":[{"id":"qwen3","name":"Qwen3 Coder","contextTokens":32768},{"id":"bare"}],"loading":1}}
        """)
        let s = try XCTUnwrap(MachineSummary.from(raw))
        XCTAssertEqual(s.version, "0.9.3")
        XCTAssertEqual(s.uptimeMs, 273_600_000)
        XCTAssertEqual(s.cpuModel, "Apple M4 Max")
        XCTAssertEqual(s.cpuCores, 16)
        XCTAssertTrue(s.unified)
        XCTAssertEqual(s.gpus.map(\.cores), [40])
        XCTAssertEqual(s.backends, ["metal", "cpu"])
        XCTAssertEqual(s.engineVersion, "b7000")
        XCTAssertEqual(s.gpuC, 55, "the GPU probe's temperature wins over the system sensor")
        XCTAssertEqual(s.gpuUsedMB, 15000)
        XCTAssertTrue(s.serverRunning)
        XCTAssertEqual(s.resident.map(\.name), ["Qwen3 Coder", "bare"])
        XCTAssertEqual(s.loading, 1)
        XCTAssertNil(MachineSummary.from(.string("no")))
        let bare = try XCTUnwrap(MachineSummary.from(try JSONValue.parse(#"{"uptimeMs":0}"#)))
        XCTAssertFalse(bare.serverRunning)
        XCTAssertTrue(bare.resident.isEmpty)
    }

    func testRoundTripsKeepTheLastTwentyAndNameTheirQuality() {
        var samples: [RoundTrip] = []
        for i in 0..<25 { samples = RoundTrips.append(samples, RoundTrip(at: Int64(i), ms: i * 10)) }
        XCTAssertEqual(samples.count, 20)
        XCTAssertEqual(samples.first?.at, 5)
        XCTAssertEqual(samples.last?.ms, 240)
        XCTAssertEqual(RoundTrips.quality(38), "Fast")
        XCTAssertEqual(RoundTrips.quality(120), "Good")
        XCTAssertEqual(RoundTrips.quality(500), "Slow")
        XCTAssertEqual(RoundTrips.quality(2000), "Very slow")
    }

    func testTodayIsTheUsageSummarysUtcDay() {
        XCTAssertEqual(MachineModel.dayKey(1_761_300_000_000), "2026-10-24")
    }
}
