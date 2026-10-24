import XCTest
@testable import NekkoProtocol

/// The same cases as `modelEffortLevels` in packages/shared/src/model-capabilities.test.ts.
final class ModelEffortTests: XCTestCase {
    func testOffersEachModelItsOwnLadder() {
        let claude: [Effort] = [.low, .medium, .high, .xhigh, .max]
        XCTAssertEqual(Effort.levels(for: "claude-opus-5-5"), claude)
        XCTAssertEqual(Effort.levels(for: "claude-fable-5-1"), claude)
        XCTAssertEqual(Effort.levels(for: "claude-haiku-5-5"), claude)
        XCTAssertEqual(Effort.levels(for: "us.anthropic.claude-opus-4-7"), claude)
        XCTAssertEqual(Effort.levels(for: "anthropic/claude-sonnet-5"), claude)
        XCTAssertEqual(Effort.levels(for: "claude-haiku-4-5"), [.low, .normal, .high])
        XCTAssertEqual(Effort.levels(for: "claude-opus-4-20250514"), [.low, .normal, .high])
        XCTAssertEqual(Effort.levels(for: "gpt-5"), [.low, .medium, .normal, .high])
        XCTAssertEqual(Effort.levels(for: "openai/gpt-6-sol"), [.low, .medium, .normal, .high])
        XCTAssertEqual(Effort.levels(for: "qwen3-8b"), [.low, .normal, .high])
    }
}
