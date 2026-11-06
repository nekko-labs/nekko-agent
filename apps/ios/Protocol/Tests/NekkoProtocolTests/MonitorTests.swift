import XCTest
@testable import NekkoProtocol

/// The Expert monitor's readings as the computer sends them (phone-views.ts).
final class MonitorTests: XCTestCase {
    func testReadsHardware() throws {
        let s = try XCTUnwrap(SystemStats.from(["cpuPct": 41, "cpuCores": 16, "cpuModel": "Ryzen", "memUsedMB": 8192, "memTotalMB": 32768, "temps": ["cpuC": 61.5]]))
        XCTAssertEqual(s.cpuPct, 41)
        XCTAssertEqual(s.memFraction, 0.25)
        XCTAssertEqual(s.cpuC, 61.5)
        XCTAssertNil(s.gpuC)
        XCTAssertNil(SystemStats.from(nil))
        XCTAssertNil(SystemStats.from(["memUsedMB": 1]), "no CPU reading")
        XCTAssertNil(SystemStats(cpuPct: 1, memUsedMB: 1, memTotalMB: 0).memFraction)

        let g = try XCTUnwrap(GpuStats.from(["totalMB": 24000, "usedMB": 6000, "unified": true,
                                             "devices": [["name": "M4 Max", "utilizationPct": 77], "junk"]]))
        XCTAssertEqual(g.devices.map(\.name), ["M4 Max"])
        XCTAssertEqual(g.devices.first?.utilizationPct, 77)
        XCTAssertEqual(g.memFraction, 0.25)
        XCTAssertTrue(g.unified)
    }

    func testReadsTheModelServer() throws {
        let e = try XCTUnwrap(EngineStatus.from([
            "installed": true, "running": true,
            "resident": [
                ["id": "google/gemma-4-e4b", "contextLength": 32768, "vramBytes": 4_000_000_000, "sizeBytes": 9, "loadedOn": "gpu", "gpuLayers": 42, "totalLayers": 42],
                ["id": "qwen", "sizeBytes": 4_000_000_000, "loadedOn": "gpu+cpu"],
                ["contextLength": 1],
            ],
            "loading": [["id": "llama", "phase": "loading", "progress": 0.5]],
            "memory": ["budgetBytes": 16_000_000_000, "kind": "vram"],
        ]))
        XCTAssertEqual(e.resident.map(\.id), ["google/gemma-4-e4b", "qwen"])
        XCTAssertEqual(e.resident[0].bytes, 4_000_000_000, "GPU memory beats the file size")
        XCTAssertFalse(e.resident[0].split)
        XCTAssertTrue(e.resident[1].split)
        XCTAssertEqual(e.loading.first?.progress, 0.5)
        XCTAssertEqual(e.memFraction, 0.5)
        XCTAssertEqual(e.memoryKind, "vram")
        let off = try XCTUnwrap(EngineStatus.from(["installed": false, "running": false]))
        XCTAssertTrue(off.resident.isEmpty)
        XCTAssertNil(off.memFraction)
    }

    func testReadsAChatContext() throws {
        let c = try XCTUnwrap(ContextUsage.from(["usedTokens": 96000, "contextWindow": 128000,
                                                 "sources": ["system": 1200, "conversation": 90000, "memory": 0, "attached-file": 4800]]))
        XCTAssertEqual(c.sources.map(\.source), ["conversation", "attached-file", "system"])
        XCTAssertEqual(c.fraction, 0.75)
        XCTAssertEqual(c.tone, .warn)
        XCTAssertEqual(ContextUsage(usedTokens: 120_000, contextWindow: 128_000).tone, .hot)
        XCTAssertEqual(ContextUsage(usedTokens: 10, contextWindow: 128_000).tone, .ok)
        let unknown = try XCTUnwrap(ContextUsage.from(["usedTokens": 10, "contextWindow": 0]))
        XCTAssertNil(unknown.contextWindow)
        XCTAssertNil(unknown.fraction)
        XCTAssertEqual(unknown.tone, .ok)
        XCTAssertNil(ContextUsage.from(["contextWindow": 5]))
    }

    func testTonesAndFormats() {
        XCTAssertEqual(MonitorTone.of(0.5), .ok)
        XCTAssertEqual(MonitorTone.of(0.8), .warn)
        XCTAssertEqual(MonitorTone.of(0.95), .hot)
        XCTAssertEqual(MonitorTone.temperature(85), .warn)
        XCTAssertEqual(MonitorTone.temperature(91), .hot)
        XCTAssertEqual(MonitorFormat.tokens(950), "950")
        XCTAssertEqual(MonitorFormat.tokens(12_340), "12.3k")
        XCTAssertEqual(MonitorFormat.tokens(2_000), "2k")
        XCTAssertEqual(MonitorFormat.tokens(131_072), "131k")
        XCTAssertEqual(MonitorFormat.tokens(1_050_000), "1.05M")
        XCTAssertEqual(MonitorFormat.bytes(4_294_967_296), "4 GB")
        XCTAssertEqual(MonitorFormat.bytes(5_100_000_000), "4.7 GB")
        XCTAssertEqual(MonitorFormat.bytes(524_288_000), "500 MB")
        XCTAssertEqual(MonitorFormat.memory(usedMB: 9626, totalMB: 32768), "9.4 / 32 GB")
    }

    func testTheSessionCarriesItsEffort() {
        XCTAssertEqual(Session.from(["id": "s", "effort": "high"])?.effort, "high")
        XCTAssertNil(Session.from(["id": "s"])?.effort)
    }
}
