import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// Streamed text and reasoning are folded into the turn once per display frame,
/// not once per delta (#3387; audit item 13). The saved-blocks-parsed-once and
/// patch-the-last-block design is unchanged.
@MainActor
final class StreamThrottleTests: XCTestCase {
    private func text(_ d: String) -> JSONValue { ["type": "text", "sessionId": "s", "delta": .string(d)] }

    private func longChat(_ n: Int, _ c: FakeConnection) {
        let messages: [JSONValue] = (0..<n).map { i in
            ["id": .string("m\(i)"), "role": i % 2 == 0 ? "user" : "assistant", "content": .string("message \(i) " + String(repeating: "word ", count: 80))]
        }
        c.replies[Channels.sessionGet] = { _ in ["id": "s", "title": "T", "messages": .array(messages), "queue": []] }
    }

    func testABurstWithinAFrameIsOneApplication() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        // A frame far longer than sending the burst takes, so a loaded simulator can't
        // fire it mid-burst (run 45952198555: 2 applications at 0.05 s).
        chat.deltaInterval = 0.5
        await chat.start()?.value
        for i in 0..<200 { c.event(text("w\(i) ")) }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(chat.deltaApplications, 0, "nothing is folded in before the frame")
        let before = chat.blocksRevision
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(chat.deltaApplications, 1, "200 deltas, one application")
        XCTAssertEqual(chat.blocksRevision, before + 1, "one change for the view")
        guard case .assistant(_, let reply, _, _, _)? = chat.blocks.last else { return XCTFail("a reply is streaming") }
        XCTAssertEqual(reply, (0..<200).map { "w\($0) " }.joined())
        XCTAssertEqual(chat.liveChars, reply.utf16.count, "the character count still covers every delta")
        chat.stop()
    }

    func testOtherEventsLandAfterTheTextBeforeThem() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.deltaInterval = 60
        await chat.start()?.value
        c.event(text("Let me "))
        c.event(text("look."))
        c.event(["type": "tool_call", "sessionId": "s", "call": ["id": "t1", "name": "bash", "input": [:]]])
        c.event(text("Done"))
        try await Task.sleep(nanoseconds: 50_000_000)
        // The tool call flushed the first two deltas; the last is still waiting for its frame.
        let ids = chat.turn.blocks.map(\.id)
        XCTAssertEqual(ids.count, 2, "the reply before the tool call, then the call")
        chat.flushDeltas()
        XCTAssertEqual(chat.turn.blocks.count, 3, "the text after the call is its own block")
        guard case .assistant(_, let first, _, _, _) = chat.turn.blocks[0] else { return XCTFail("order") }
        XCTAssertEqual(first, "Let me look.")
        chat.stop()
    }

    func testTheTurnEndingTakesTheLastFrameWithIt() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.deltaInterval = 60
        await chat.start()?.value
        c.event(text("Hello"))
        c.event(["type": "done", "sessionId": "s"])
        try await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(chat.deltaApplications, 1, "the text waiting for its frame was folded in before the turn ended")
        XCTAssertFalse(chat.running)
        guard case .assistant(_, let reply, _, _, _)? = chat.blocks.last else { return XCTFail("text lost at the end of the turn") }
        XCTAssertEqual(reply, "Hello")
        chat.flushDeltas()
        XCTAssertEqual(chat.deltaApplications, 1, "nothing is left waiting")
        chat.stop()
    }

    func testZeroAppliesEveryDeltaAsItArrives() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        chat.deltaInterval = 0
        await chat.start()?.value
        for i in 0..<5 { c.event(text("w\(i) ")) }
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .assistant(_, let reply, _, _, _)? = chat.blocks.last else { return XCTFail("a reply is streaming") }
        XCTAssertEqual(reply, "w0 w1 w2 w3 w4 ")
        XCTAssertEqual(chat.deltaApplications, 0, "the throttle is not involved")
        chat.stop()
    }

    /// What the main actor pays to fold 2,000 deltas that arrive inside one frame into a
    /// 300-message chat: each delta on its own (the old behaviour, `deltaInterval` 0) ...
    func testMeasureFoldingEveryDelta() async throws {
        try await measureStream(interval: 0)
    }

    /// ... and coalesced to one write for the frame.
    func testMeasureFoldingOncePerFrame() async throws {
        try await measureStream(interval: 60)
    }

    private func measureStream(interval: TimeInterval) async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        longChat(300, c)
        let chat = ChatModel(sessionId: "s", store: s)
        chat.deltaInterval = interval
        await chat.start()?.value
        XCTAssertEqual(chat.blocks.count, 300)
        let deltas = (0..<2_000).map { text("token\($0) ") }
        let payloads = deltas.compactMap { v -> AgentEvent? in AgentEvent.from(v) }
        XCTAssertEqual(payloads.count, 2_000)
        measure(metrics: [XCTClockMetric()]) {
            for e in payloads { chat.onEvent(e) }
            chat.flushDeltas()
        }
        chat.stop()
    }
}
