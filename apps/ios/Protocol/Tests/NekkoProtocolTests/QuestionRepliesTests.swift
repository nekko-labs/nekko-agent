import XCTest
@testable import NekkoProtocol

final class QuestionRepliesTests: XCTestCase {
    private let body = "Q: Which scope?\nA: App — Keep **this**\nexact note\n\nQ: Which tests?\nA: (not answered)"
    private func output(_ body: String) -> String { "The user answered:\n\n\(body)\n\nWork to these answers. Do not ask again about anything settled here." }

    func testVisibleDuringLiveSavedHandoffAndReopenWithoutChangingPromptAnchors() throws {
        let result = output(body)
        let values: [JSONValue] = [
            ["id": "p", "role": "user", "content": "Start", "createdAt": 1],
            ["id": "a", "role": "assistant", "content": "", "createdAt": 2, "toolCalls": [["id": "ask", "name": "ask_user", "input": [:]]]],
            ["id": "r", "role": "tool", "content": "", "createdAt": 3, "toolResult": ["toolCallId": "ask", "output": .string(result)]],
        ]
        let saved = Transcript.fromMessages(try values.map { try XCTUnwrap(ChatMessage.from($0)) })
        var live = LiveTurn(blocks: [.user(id: "p", text: "Start", at: 1, images: 0)])
        live = Transcript.apply(live, .toolCall(sessionId: "s", call: ToolCall(id: "ask", name: "ask_user")))
        live = Transcript.apply(live, .toolResult(sessionId: "s", result: ToolResult(toolCallId: "ask", output: result, isError: false, outputChars: nil, omittedImages: 0)))
        for blocks in [Transcript.mergeLive(saved: [], live: live.blocks), Transcript.mergeLive(saved: saved, live: live.blocks), Transcript.mergeLive(saved: saved, live: [])] {
            let replies = QuestionReplies.project(blocks).filter { $0.id.hasPrefix("ask-answer:") }
            XCTAssertEqual(replies.count, 1)
            guard case .user(_, let text, _, _) = replies.first else { return XCTFail("Missing answer") }
            XCTAssertEqual(text, body)
        }
        XCTAssertEqual(saved.filter { $0.isUser }.count, 1)
    }

    func testRejectsFailuresUnrelatedToolsAndIncompleteOutputs() {
        XCTAssertNil(QuestionReplies.body(name: "bash", output: output(body)))
        XCTAssertNil(QuestionReplies.body(name: "ask_user", output: "The user answered:\n\nincomplete"))
        let failed = Block.tool(id: "ask", name: "ask_user", label: "Ask", status: .error, output: output(body), input: [:])
        XCTAssertEqual(QuestionReplies.project([failed]), [failed])
    }

    func testLongLiveAnswerIsNotClippedBeforeProjection() {
        let long = String(repeating: "x", count: 5000)
        var live = Transcript.apply(LiveTurn(), .toolCall(sessionId: "s", call: ToolCall(id: "ask", name: "ask_user")))
        live = Transcript.apply(live, .toolResult(sessionId: "s", result: ToolResult(toolCallId: "ask", output: output("Q: Scope?\nA: \(long)"), isError: false, outputChars: nil, omittedImages: 0)))
        guard case .user(_, let text, _, _) = QuestionReplies.project(live.blocks).last else { return XCTFail("Missing long answer") }
        XCTAssertTrue(text.contains(long))
    }
}
