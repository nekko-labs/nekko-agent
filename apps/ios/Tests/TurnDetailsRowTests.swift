import XCTest
import NekkoProtocol
@testable import NekkoNative

@MainActor
final class TurnDetailsRowTests: XCTestCase {
    private func reply(_ id: String, tools: [String] = []) throws -> ChatMessage {
        try XCTUnwrap(ChatMessage.from([
            "id": .string(id), "role": "assistant", "content": .string(tools.isEmpty ? "Finished" : ""),
            "toolCalls": .array(tools.map { ["id": .string($0), "name": "read_file", "input": ["path": "file.swift"]] }),
            "turnStats": ["providerId": "p", "modelId": "m", "inputTokens": 100, "outputTokens": 50,
                          "wallMs": 5000, "calls": 1, "stop": "complete"],
        ]))
    }

    func testFooterStaysVisibleWhenSimpleFoldsAToolOnlyTurn() async throws {
        let messages = [try reply("a", tools: ["c1", "c2"])]
        let footers = TurnDetails.footers(messages)
        let rows = TranscriptRow.of(Transcript.fromMessages(messages), footers: footers)
        let folded = TranscriptRow.folded(rows, open: [], footers: footers)
        XCTAssertEqual(folded.map(\.id), ["steps-start", "turn-details-a"])
        guard case .details(let details) = try XCTUnwrap(folded.last) else { return XCTFail("folding must keep the footer") }
        XCTAssertTrue(details.successful)
        let open = TranscriptRow.folded(rows, open: ["start"], footers: footers)
        XCTAssertEqual(open.filter { $0.id == "turn-details-a" }.count, 1)
        XCTAssertEqual(TranscriptRow.detailed(rows, footers: footers).last?.id, "turn-details-a")
    }

    func testPurposeGroupsCannotSwallowThePreviousTurnFooter() async throws {
        let messages = [try reply("a1", tools: ["c1", "c2"]), try reply("a2", tools: ["c3", "c4"])]
        let footers = TurnDetails.footers(messages)
        let rows = TranscriptRow.of(Transcript.fromMessages(messages), footers: footers)
        XCTAssertEqual(rows.count, 2, "same-purpose calls on opposite sides of a footer are separate groups")
        let items = TranscriptRow.detailed(rows, footers: footers)
        XCTAssertEqual(items.map(\.id), [rows[0].id, "turn-details-a1", rows[1].id, "turn-details-a2"])
    }

    func testCarriedAssistantIdRendersExactlyOneFooter() async throws {
        let message = try reply("saved-a")
        let shown = Transcript.fromMessages([message]).map { $0.withId("live-42-0") }
        let footers = TurnDetails.footers([message], shownIds: ["saved-a": "live-42-0"])
        let rows = TranscriptRow.of(shown, footers: footers)
        XCTAssertEqual(TranscriptRow.detailed(rows, footers: footers).map(\.id), ["live-42-0", "turn-details-saved-a"])
    }
}
