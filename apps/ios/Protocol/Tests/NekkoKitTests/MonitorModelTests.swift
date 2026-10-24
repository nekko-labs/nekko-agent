import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer as the Monitors pane sees it.
@MainActor
final class FakeMonitors: MonitorBackend {
    var calls: [(String, [JSONValue])] = []
    var listeners: [UUID: (AgentEvent) -> Void] = [:]
    var online = true
    var refuse: Error?
    var summary: JSONValue = [
        "hardware": ["cpu": ["loadPct": 42.5, "cores": 16, "tempC": 71], "memory": ["usedMB": 20000, "totalMB": 65536], "gpu": .null],
        "running": [["id": "s1", "title": "Fix the build", "step": "approval", "elapsedMs": 65000]],
        "needsYou": [
            ["sessionId": "s3", "title": "Idle", "kind": "question", "callId": "q1", "label": "Which auth method?", "count": 1, "since": 300],
            ["sessionId": "s1", "title": "Fix the build", "kind": "approval", "callId": "tc1", "risk": "high", "label": "bash", "since": 500],
        ],
        "automations": [["kind": "task", "id": "t1", "name": "Nightly", "nextRunAt": 3]],
    ]
    let computerName = "Studio"

    var isOnline: Bool { online }

    func read(_ channel: String, _ args: [JSONValue]) async throws -> JSONValue {
        calls.append((channel, args))
        if let refuse, channel == Channels.monitorSummary { throw refuse }
        switch channel {
        case Channels.monitorSummary: return summary
        case Channels.chatPending:
            return ["s3": ["question": ["callId": "q1", "questions": [
                ["id": "q", "header": "Auth", "question": "Which auth method?", "multiSelect": false,
                 "options": [["label": "OAuth", "description": ""], ["label": "Keys", "description": ""]]],
            ]]]]
        default: return .null
        }
    }

    func subscribe(_ f: @escaping (AgentEvent) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = f
        return id
    }

    func unsubscribe(_ id: UUID) { listeners[id] = nil }

    func emit(_ e: AgentEvent) { for f in listeners.values { f(e) } }

    func count(_ channel: String) -> Int { calls.filter { $0.0 == channel }.count }
}

@MainActor
final class MonitorModelTests: XCTestCase {
    func testReadsTheSummaryAndTheWaitingQuestions() async throws {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c)
        await m.refresh()
        XCTAssertEqual(m.running.map(\.id), ["s1"])
        XCTAssertEqual(m.needsYou.map(\.callId), ["q1", "tc1"])
        XCTAssertEqual(m.automations.map(\.name), ["Nightly"])
        XCTAssertEqual(c.calls.first?.1, [], "the phone sends no arguments")
        let q = try XCTUnwrap(m.question(m.needsYou[0]))
        XCTAssertEqual(q.questions.first?.options.map(\.label), ["OAuth", "Keys"])
        XCTAssertNil(m.question(m.needsYou[1]), "an approval has no question")
        XCTAssertTrue(m.loadedOnce)
    }

    func testNoQuestionWaitingNoPendingRead() async {
        let c = FakeMonitors()
        c.summary = ["hardware": ["cpu": [:], "memory": [:], "gpu": .null], "running": [], "needsYou": [], "automations": []]
        let m = MonitorModel(backend: c)
        await m.refresh()
        XCTAssertEqual(c.count(Channels.chatPending), 0)
        XCTAssertTrue(m.questions.isEmpty)
    }

    func testReadOffSaysSoAndForgetsWhatItShowed() async {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c)
        await m.refresh()
        XCTAssertNotNil(m.summary)
        c.refuse = RelayError("Not allowed from a paired phone (read-off): monitor:summary", fromComputer: true)
        await m.refresh()
        XCTAssertTrue(m.readOff)
        XCTAssertNil(m.summary, "nothing read before stays on screen once Read is off")
        XCTAssertNil(m.error)
        c.refuse = nil
        await m.refresh()
        XCTAssertFalse(m.readOff)
    }

    func testAnOlderComputerIsNamedAsSuch() async {
        let c = FakeMonitors()
        c.refuse = RelayError("Not allowed from a paired phone (channel-denied): monitor:summary", fromComputer: true)
        let m = MonitorModel(backend: c)
        await m.refresh()
        XCTAssertTrue(m.unsupported)
        XCTAssertFalse(m.readOff)
        c.refuse = RelayError("Unknown channel: monitor:summary", fromComputer: true)
        let old = MonitorModel(backend: c)
        await old.refresh()
        XCTAssertTrue(old.unsupported)
    }

    func testOfflineKeepsTheLastReadAndCallsNothing() async {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c)
        await m.refresh()
        let n = c.calls.count
        c.online = false
        await m.refresh()
        XCTAssertEqual(c.calls.count, n)
        XCTAssertNotNil(m.summary)
    }

    func testAllowAndAnswerGoThroughTheChatsOwnCalls() async throws {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c)
        await m.refresh()
        let approval = m.needsYou[1]
        try await m.approve(approval, allow: true)
        let approve = try XCTUnwrap(c.calls.last { $0.0 == Channels.toolApprove })
        XCTAssertEqual(approve.1, [.string("s1"), .string("tc1"), .bool(true)])
        XCTAssertFalse(m.needsYou.contains(approval), "hidden until the next read")

        let question = m.needsYou[0]
        try await m.answer(question, [AskAnswer(questionId: "q", labels: ["OAuth"], note: nil)])
        let answer = try XCTUnwrap(c.calls.last { $0.0 == Channels.chatAnswer })
        XCTAssertEqual(answer.1.prefix(2), [.string("s3"), .string("q1")])
        XCTAssertTrue(m.needsYou.isEmpty)

        await m.refresh()
        XCTAssertEqual(m.needsYou.count, 2, "a fresh read shows what the computer still waits on")
    }

    func testAnswersAreNeverSentLater() async {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c)
        await m.refresh()
        c.online = false
        do {
            try await m.approve(m.needsYou[1], allow: false)
            XCTFail("offline approval must throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.reconnectToAnswer)
        }
        XCTAssertEqual(c.count(Channels.toolApprove), 0)
    }

    func testPollsOnlyWhileWatched() async throws {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c, interval: 3600)
        m.start()
        for _ in 0..<50 where c.count(Channels.monitorSummary) == 0 { await Task.yield() }
        XCTAssertEqual(c.count(Channels.monitorSummary), 1, "one read on appearing")
        XCTAssertEqual(c.listeners.count, 1)
        m.stop()
        XCTAssertTrue(c.listeners.isEmpty)
        XCTAssertFalse(m.watching)
        c.emit(.approvalRequired(sessionId: "s1", approval: Approval(call: ToolCall(id: "x", name: "bash"), reason: "", severity: .low)))
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(c.count(Channels.monitorSummary), 1, "nothing is read once the pane has gone")
    }

    func testAnApprovalEventBringsTheNextReadForward() async throws {
        let c = FakeMonitors()
        let m = MonitorModel(backend: c, interval: 3600)
        m.start()
        for _ in 0..<50 where c.count(Channels.monitorSummary) == 0 { await Task.yield() }
        c.emit(.text(sessionId: "s1", delta: "hi"))
        c.emit(.approvalRequired(sessionId: "s1", approval: Approval(call: ToolCall(id: "x", name: "bash"), reason: "", severity: .low)))
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(c.count(Channels.monitorSummary), 2, "streamed text doesn't re-read; an approval does, once")
        m.stop()
    }

    func testWords() {
        XCTAssertEqual(MonitorModel.elapsed(12_000), "12 s")
        XCTAssertEqual(MonitorModel.elapsed(240_000), "4 min")
        XCTAssertEqual(MonitorModel.elapsed(3_900_000), "1 h 5 min")
        XCTAssertEqual(MonitorModel.elapsed(7_200_000), "2 h")
        XCTAssertEqual(MonitorModel.elapsed(-5), "0 s")
        XCTAssertEqual(MonitorModel.temperature(70.6), "71 °C")
        XCTAssertEqual(MonitorModel.memory(usedMB: 20000, totalMB: 65536), "20 of 64 GB")
        XCTAssertEqual(MonitorModel.memory(usedMB: 2048, totalMB: 8192), "2.0 of 8.0 GB")
        XCTAssertEqual(MonitorModel.memory(usedMB: 300, totalMB: 512), "300 of 512 MB")
    }
}
