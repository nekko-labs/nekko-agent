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

extension ModelEffortTests {
    func testConcreteEffortAndIndependentRecommendation() {
        XCTAssertEqual(Effort.recommended(for: "claude-opus-5-5"), .medium)
        XCTAssertEqual(Effort.recommended(for: "claude-sonnet-5"), .high)
        XCTAssertEqual(Effort.recommended(for: "gpt-5"), .normal)
        XCTAssertEqual(Effort.effective(.normal, for: "claude-opus-5-5"), .medium)
        XCTAssertEqual(Effort.effective(.max, for: "gpt-5"), .high)
        XCTAssertEqual(Effort.effective(.medium, for: "qwen3"), .normal)
        for model in ["claude-opus-5-5", "claude-sonnet-5", "gpt-5", "qwen3"] {
            for effort in Effort.allCases {
                XCTAssertTrue(Effort.levels(for: model).contains(Effort.effective(effort, for: model)))
            }
        }
    }

    func testReadsComputerEffortWithoutExposingASettingsWrite() {
        XCTAssertEqual(PcSettings.from(.object(["effort": .string("xhigh")])).effort, .xhigh)
        XCTAssertNil(PcSettings.from(.object(["effort": .string("invalid")])).effort)
        XCTAssertNil(PcSettings.from(nil).effort)
        XCTAssertNil(PcSettings.patch(mode: .ask)["effort"])
    }

    func testReadsTheComputersDelegationStrategy() {
        XCTAssertEqual(PcSettings.from(.object(["orchestration": .object(["strategy": .string("solo")])])).orchestrationStrategy, "solo")
        XCTAssertNil(PcSettings.from(.object([:])).orchestrationStrategy, "a computer from before this says nothing")
    }

    func testOffersASubagentOnlyWhereDelegationCanRun() throws {
        let reply: [String: JSONValue] = ["id": "s", "messages": .array([.object(["id": "a", "role": "assistant", "content": "Done"])])]
        func chat(_ extra: [String: JSONValue] = [:]) throws -> Session { try XCTUnwrap(Session.from(.object(reply.merging(extra) { _, new in new }))) }
        XCTAssertTrue(try chat().canOfferSubagent(strategy: "balanced"))
        XCTAssertTrue(try chat().canOfferSubagent(strategy: nil))
        XCTAssertFalse(try chat().canOfferSubagent(strategy: "solo"))
        XCTAssertFalse(try chat(["messages": .array([.object(["id": "u", "role": "user", "content": "Hi"])])]).canOfferSubagent(strategy: nil), "needs a reply to follow up on")
        for extra: [String: JSONValue] in [["parentSessionId": "p"], ["incognito": true], ["offline": true], ["executionMode": "sandbox"],
                                           ["disabledTools": .array(["spawn_agent"])], ["chatType": "image"]] {
            XCTAssertFalse(try chat(extra).canOfferSubagent(strategy: nil), "\(extra)")
        }
    }

    func testAskingForASubagentKeepsTheMessageWhole() {
        XCTAssertEqual(Session.inSubagent("Fix the tests"), "Do this in a subagent, then report back:\n\nFix the tests")
    }
}
