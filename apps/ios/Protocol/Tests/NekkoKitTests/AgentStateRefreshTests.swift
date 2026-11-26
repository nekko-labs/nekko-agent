import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A delegating chat re-reads the chat list (and the watches) only when a tool
/// result can change them, and a burst of such results is answered by one more
/// read, not one each (#3384; audit item 4).
@MainActor
final class AgentStateRefreshTests: XCTestCase {
    private func call(_ id: String, _ name: String) -> JSONValue {
        ["type": "tool_call", "sessionId": "s", "call": ["id": .string(id), "name": .string(name), "input": [:]]]
    }
    private func result(_ id: String) -> JSONValue {
        ["type": "tool_result", "sessionId": "s", "result": ["toolCallId": .string(id), "output": "ok"]]
    }

    func testOtherToolsResultsReadNothing() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        c.event(call("d", "spawn_agent"))
        c.event(result("d"))
        try await Task.sleep(nanoseconds: 200_000_000)
        let before = c.callsTo(Channels.sessionsSummaries).count
        XCTAssertGreaterThan(before, 0, "the sub-agent's own result read the list")
        for i in 0..<10 {
            c.event(call("b\(i)", "bash"))
            c.event(result("b\(i)"))
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(c.callsTo(Channels.sessionsSummaries).count, before, "ten shell results read the list zero times")
        chat.stop()
    }

    func testABurstOfSubAgentResultsIsCoalesced() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        c.event(call("d0", "spawn_agent"))
        try await Task.sleep(nanoseconds: 100_000_000)
        let before = c.callsTo(Channels.sessionsSummaries).count
        // The first read is held open while the rest of the burst arrives.
        var gate: CheckedContinuation<JSONValue, Error>?
        c.summariesReply = { try await withCheckedThrowingContinuation { gate = $0 } }
        for i in 0..<8 {
            c.event(call("d\(i + 1)", "spawn_agent"))
            c.event(result("d\(i + 1)"))
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(c.callsTo(Channels.sessionsSummaries).count, before + 1, "one read in flight, not eight")
        c.summariesReply = { [["id": "kid", "title": "k", "updatedAt": 1, "parentSessionId": "s"]] }
        gate?.resume(returning: [])
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(c.callsTo(Channels.sessionsSummaries).count, before + 2, "one more read for everything that arrived meanwhile")
        XCTAssertEqual(chat.children.map(\.id), ["kid"])
        chat.stop()
    }
}
