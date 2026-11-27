import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class TurnStrategyRowTests: XCTestCase {
    func testSectionsPrecedeTheirPromptsInBothModes() async throws {
        let messages = [
            try XCTUnwrap(ChatMessage.from(["id": "old", "role": "user", "content": "Older chat"])),
            try XCTUnwrap(ChatMessage.from(["id": "u1", "role": "user", "content": "Check it",
                                          "turnStrategy": ["tools": "code", "orchestration": "direct"]])),
            try XCTUnwrap(ChatMessage.from(["id": "a", "role": "assistant", "content": "Okay", "reasoning": "Checking"])),
            try XCTUnwrap(ChatMessage.from(["id": "u2", "role": "user", "content": "Then plan",
                                          "turnStrategy": ["tools": "code", "orchestration": "coordinator"]])),
        ]
        let strategies = TurnStrategy.sections(messages, shownIds: ["u1": "live-u1"])
        let rows = TranscriptRow.of(Transcript.fromMessages(messages).map { $0.id == "u1" ? $0.withId("live-u1") : $0 })
        for items in [TranscriptRow.detailed(rows, footers: [:], strategies: strategies),
                      TranscriptRow.folded(rows, open: [], strategies: strategies),
                      TranscriptRow.folded(rows, open: ["live-u1"], strategies: strategies)] {
            let ids = items.map(\.id).filter { !$0.hasPrefix("steps-") }
            XCTAssertEqual(ids, ["old", "turn-strategy-live-u1", "live-u1", "a", "turn-strategy-u2", "u2"])
        }
    }
}
