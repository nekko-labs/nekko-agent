import XCTest
@testable import NekkoProtocol

final class ModelMetaTests: XCTestCase {
    func testLocalModelsShowParametersAndSize() {
        XCTAssertEqual(ModelMeta.line(local: true, parameters: "8B", sizeBytes: 4_920_000_000), "8B · 4.9 GB")
        XCTAssertEqual(ModelMeta.line(local: true, sizeBytes: 3_100_000_000), "3.1 GB")
        XCTAssertEqual(ModelMeta.line(local: true, sizeBytes: 16_000_000_000), "16 GB")
        XCTAssertEqual(ModelMeta.line(local: true, sizeBytes: 850_000_000), "850 MB")
        XCTAssertNil(ModelMeta.line(local: true, parameters: " ", sizeBytes: 0))
        // A local model's context is not what its row is about.
        XCTAssertNil(ModelMeta.line(local: true, contextLength: 32_768))
    }

    func testCloudModelsShowContextOnlyWhenListed() {
        XCTAssertEqual(ModelMeta.line(local: false, contextLength: 400_000), "400K context")
        XCTAssertEqual(ModelMeta.line(local: false, contextLength: 1_000_000), "1M context")
        XCTAssertEqual(ModelMeta.line(local: false, contextLength: 1_048_576), "1M context")
        XCTAssertEqual(ModelMeta.line(local: false, contextLength: 128_000), "128K context")
        XCTAssertNil(ModelMeta.line(local: false, sizeBytes: 9_000_000_000))
        XCTAssertNil(ModelMeta.line(local: false))
    }

    func testDateSuffixes() {
        XCTAssertEqual(ModelSnapshots.base("o3-2025-04-16"), "o3")
        XCTAssertEqual(ModelSnapshots.base("gpt-5.5-pro-2026-04-23"), "gpt-5.5-pro")
        XCTAssertEqual(ModelSnapshots.base("claude-sonnet-4-20250514"), "claude-sonnet-4")
        XCTAssertNil(ModelSnapshots.base("gpt-6.1-sol"))
        XCTAssertNil(ModelSnapshots.base("qwen3:8b"))
        XCTAssertNil(ModelSnapshots.base("claude-opus-4-8"))
        XCTAssertNil(ModelSnapshots.base("2025-04-16"))
    }

    func testSnapshotsFoldUnderTheirModel() {
        let folds = ModelSnapshots.fold(["o3-2025-04-16", "o3", "gpt-live-1", "gpt-5.5-pro-2026-04-23", "gpt-5.5-pro"])
        XCTAssertEqual(folds, [
            .init(main: "o3", dated: ["o3-2025-04-16"]),
            .init(main: "gpt-live-1", dated: []),
            .init(main: "gpt-5.5-pro", dated: ["gpt-5.5-pro-2026-04-23"]),
        ])
    }

    func testModelInfoKeepsSizeContextAndDetails() {
        let list = ModelInfo.list(.array([
            .object(["id": .string("qwen3:8b"), "providerId": .string("ollama"), "name": .string("qwen3:8b"),
                     "sizeBytes": .int(5_200_000_000), "details": .object(["family": .string("qwen3"), "parameterSize": .string("8B"), "n": .int(3)])]),
            .object(["id": .string("openai/gpt-6.1-sol"), "providerId": .string("openrouter"), "contextLength": .int(400_000), "sizeBytes": .int(0)]),
        ]))
        XCTAssertEqual(list[0].sizeBytes, 5_200_000_000)
        XCTAssertEqual(list[0].parameters, "8B")
        XCTAssertEqual(list[0].details, ["family": "qwen3", "parameterSize": "8B"])
        XCTAssertNil(list[0].contextLength)
        XCTAssertEqual(list[1].contextLength, 400_000)
        XCTAssertNil(list[1].sizeBytes, "a zero size is unknown")
        XCTAssertEqual(ModelMeta.line(local: true, parameters: list[0].parameters, sizeBytes: list[0].sizeBytes), "8B · 5.2 GB")
    }

    func testWithoutThePlainIdTheNewestSnapshotLeads() {
        XCTAssertEqual(ModelSnapshots.fold(["gpt-4.1-2025-01-01", "gpt-4.1-2025-04-14", "gpt-4.1-2024-11-20"]),
                       [.init(main: "gpt-4.1-2025-04-14", dated: ["gpt-4.1-2025-01-01", "gpt-4.1-2024-11-20"])])
    }
}
