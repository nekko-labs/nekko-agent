import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
final class PendingResponsesTests: XCTestCase {
    private let question: JSONValue = ["callId": "ask-1", "askedAt": 123, "questions": [
        ["id": "q1", "header": "Colour", "question": "Which colour?", "options": [["label": "Plum"]], "multiSelect": false]
    ]]
    private let approval: JSONValue = ["call": ["id": "tool-1", "name": "bash", "input": ["command": "ls"]],
                                       "reason": "Run a command", "severity": "high"]
    private var answers: [AskAnswer] { [AskAnswer(questionId: "q1", labels: ["Plum"], note: "Keep it quiet")] }
    private func pending(_ question: JSONValue? = nil, approval: JSONValue? = nil) -> JSONValue {
        var p: [String: JSONValue] = [:]
        if let question { p["question"] = question }
        if let approval { p["approval"] = approval }
        return ["s": .object(p)]
    }

    func testOfflineAnswerPersistsAndOnlyOriginalRequestDeliversOnce() async throws {
        let files = MemoryOfflineFiles()
        var reachable: Caller?
        let c = ResponseCaller()
        c.pending = pending(question)
        let queue = PendingResponses(files: files, caller: { reachable }, newId: { "response-1" })
        queue.load("computer-a")
        queue.answer("s", question: AskRequest.from(question)!, answers: answers)
        await queue.flush()
        XCTAssertTrue(c.calls.isEmpty)
        let message = try XCTUnwrap(queue.items.first)
        XCTAssertEqual(message.pendingId, "answer:ask-1")
        XCTAssertEqual(message.status, "waiting")
        let restored = PendingResponses(files: files, caller: { reachable })
        restored.load("computer-a")
        XCTAssertEqual(restored.items, queue.items)
        reachable = c
        await restored.flush()
        XCTAssertEqual(restored.items.first?.status, "sent")
        XCTAssertEqual(c.calls.filter { $0.0 == Channels.chatAnswer }.map(\.1), [["s", "ask-1", .array(answers.map(\.json))]])
        await restored.flush()
        XCTAssertEqual(c.calls.filter { $0.0 == Channels.chatAnswer }.count, 1)
    }

    func testCancelRemovesPendingMessageAndNeverDispatches() async {
        let c = ResponseCaller()
        c.pending = pending(question)
        var reachable: Caller?
        let queue = PendingResponses(files: nil, caller: { reachable })
        queue.load("a")
        queue.answer("s", question: AskRequest.from(question)!, answers: answers)
        queue.cancel(queue.items[0].id)
        reachable = c
        await queue.flush()
        XCTAssertTrue(queue.items.isEmpty)
        XCTAssertTrue(c.calls.isEmpty)
    }

    func testChangedResolvedOrMalformedPendingNeverAuthorizesReplay() async {
        for raw: JSONValue in [[:], ["s": ["question": ["callId": "ask-1", "askedAt": 999, "questions": []]]], .null] {
            let c = ResponseCaller()
            c.pending = raw
            let queue = PendingResponses(files: nil, caller: { c })
            queue.load("a")
            queue.answer("s", question: AskRequest.from(question)!, answers: answers)
            await queue.flush()
            XCTAssertTrue(c.calls.allSatisfy { $0.0 == Channels.chatPending })
            XCTAssertEqual(queue.items.first?.status, raw == .null ? "failed" : "stale")
        }
    }

    func testApprovalIncludesArgumentsAndDenyPayload() async {
        let c = ResponseCaller()
        c.pending = pending(approval: approval)
        let a = PendingInput.map(c.pending)["s"]!.approval!
        let queue = PendingResponses(files: nil, caller: { c })
        queue.load("a")
        queue.approve("s", approval: a, ok: false)
        await queue.flush()
        XCTAssertEqual(c.calls.filter { $0.0 == Channels.toolApprove }.map(\.1), [["s", "tool-1", false]])
        XCTAssertEqual(queue.items.first?.text, "Deny bash")

        let other = ResponseCaller()
        other.pending = pending(approval: ["call": ["id": "tool-1", "name": "bash", "input": ["command": "rm x"]],
                                            "reason": "Run a command", "severity": "high"])
        let stale = PendingResponses(files: nil, caller: { other })
        stale.load("a")
        stale.approve("s", approval: a, ok: true)
        await stale.flush()
        XCTAssertEqual(stale.items.first?.status, "stale")
        XCTAssertFalse(other.calls.contains { $0.0 == Channels.toolApprove })
    }

    func testRetryAfterLostReplyChecksPendingBeforeSendingAgain() async {
        let c = ResponseCaller()
        c.pending = pending(question)
        c.failSend = true
        let queue = PendingResponses(files: nil, caller: { c })
        queue.load("a")
        queue.answer("s", question: AskRequest.from(question)!, answers: answers)
        await queue.flush()
        XCTAssertEqual(queue.items.first?.status, "failed")
        c.failSend = false
        c.pending = [:] // Host accepted it, but the phone lost the acknowledgement.
        queue.retry(queue.items[0].id)
        await queue.flush()
        XCTAssertEqual(queue.items.first?.status, "stale")
        XCTAssertEqual(c.calls.filter { $0.0 == Channels.chatAnswer }.count, 1)
    }

    func testDuplicateTapsAndConcurrentFlushCannotSendTwice() async {
        let c = ResponseCaller()
        c.pending = pending(question)
        let queue = PendingResponses(files: nil, caller: { c })
        queue.load("a")
        let q = AskRequest.from(question)!
        queue.answer("s", question: q, answers: answers)
        queue.answer("s", question: q, answers: answers)
        async let first: Void = queue.flush()
        async let second: Void = queue.flush()
        _ = await (first, second)
        XCTAssertEqual(queue.items.count, 1)
        XCTAssertEqual(c.calls.filter { $0.0 == Channels.chatAnswer }.count, 1)
    }

    func testComputerSwitchDuringPendingReadNeverCrossesScope() async {
        let files = MemoryOfflineFiles()
        let c = ResponseCaller()
        c.pending = pending(question)
        let other = ResponseCaller()
        var active: Caller = c
        let queue = PendingResponses(files: files, caller: { active })
        queue.load("a")
        c.beforePending = {
            active = other
            queue.load("b")
        }
        queue.answer("s", question: AskRequest.from(question)!, answers: answers)
        await queue.flush()
        XCTAssertTrue(queue.items.isEmpty)
        XCTAssertFalse(c.calls.contains { $0.0 == Channels.chatAnswer })
        XCTAssertFalse(other.calls.contains { $0.0 == Channels.chatAnswer })
        queue.load("a")
        XCTAssertEqual(queue.items.first?.status, "waiting", "An interrupted send is restored, not lost")
    }

    func testResponsePayloadNeverChangesGuardedSettingsOrRunsVoice() async {
        let c = ResponseCaller()
        c.pending = pending(approval: approval)
        let queue = PendingResponses(files: nil, caller: { c })
        queue.load("a")
        queue.approve("s", approval: PendingInput.map(c.pending)["s"]!.approval!, ok: true)
        await queue.flush()
        XCTAssertEqual(Set(c.calls.map(\.0)), Set([Channels.chatPending, Channels.toolApprove]))
    }
}

@MainActor
private final class ResponseCaller: Caller {
    var pending: JSONValue = [:]
    var calls: [(String, [JSONValue])] = []
    var failSend = false
    var beforePending: (() -> Void)?
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        calls.append((channel, args))
        if channel == Channels.chatPending { beforePending?(); return pending }
        if failSend { throw RelayError("Lost connection") }
        return .null
    }
}
