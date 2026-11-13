import Foundation
import XCTest
@testable import NekkoKit
import NekkoProtocol

final class AttentionTests: XCTestCase {
    func event(_ value: JSONValue) -> AgentEvent { AgentEvent.from(value)! }
    let pending: JSONValue = ["a": ["approval": ["call": ["id": "tool", "name": "bash", "input": [:]]],
                                      "question": ["callId": "question", "questions": []]],
                              "b": ["question": ["callId": "other", "questions": []]]]

    func testASecretRequestCountsAsNeedingYouUntilResolved() {
        let secret: JSONValue = ["callId": "s1", "name": "OPENAI_API_KEY", "reason": "To call the API", "requestedAt": 5]
        var state = AttentionState()
        state.replace(["a": ["secret": secret]], ticket: state.beginSnapshot())
        XCTAssertEqual(state.pending, ["a"])
        XCTAssertEqual(state.count, 1)
        XCTAssertTrue(state.receive(event(["type": "secret_resolved", "sessionId": "a", "callId": "s1", "provided": true])))
        XCTAssertNil(state.count, "a resolution needs a fresh read")
        state.replace([:], ticket: state.beginSnapshot())
        XCTAssertEqual(state.count, 0)
        state.receive(event(["type": "secret_request", "sessionId": "b", "request": secret]))
        XCTAssertEqual(state.pending, ["b"])
        XCTAssertEqual(ActivityTracker.next([:], event(["type": "secret_request", "sessionId": "b", "request": secret]))["b"], .needsYou)
        // A secret that does not decode is not proof of an empty room.
        var bad = AttentionState()
        bad.replace(["a": ["secret": ["callId": "x"]]], ticket: bad.beginSnapshot())
        XCTAssertNil(bad.count)
    }

    func testUnknownUntilCompleteSnapshotAndDistinctChatsNotInputs() {
        var state = AttentionState()
        XCTAssertNil(state.count)
        state.replace(pending, ticket: state.beginSnapshot())
        XCTAssertEqual(state.count, 2)
        state.receive(event(["type": "text", "sessionId": "a", "delta": "progress"]))
        XCTAssertEqual(state.count, 2, "streaming is not an answer")
        XCTAssertTrue(state.receive(event(["type": "question_resolved", "sessionId": "a", "callId": "question"])))
        XCTAssertNil(state.count, "even a matching answer cannot prove completeness")
        XCTAssertEqual(state.pending, ["a", "b"], "keep needs-you until the replacement read")
        state.replace(["a": ["approval": ["call": ["id": "older", "name": "bash", "input": [:]]]],
                       "b": ["question": ["callId": "other", "questions": []]]], ticket: state.beginSnapshot())
        XCTAssertEqual(state.count, 2)
        XCTAssertTrue(state.receive(event(["type": "tool_result", "sessionId": "unseen", "result": ["toolCallId": "unrelated", "output": "ok"]])))
        XCTAssertNil(state.count, "unobserved answers also require a read")
        state.replace(pending, ticket: state.beginSnapshot())
        state.dismiss(tag: E2E.activityTag("b"))
        XCTAssertNil(state.count)
        XCTAssertEqual(state.pending, ["a", "b"], "legacy dismissal is not chat-wide authority")
        XCTAssertEqual(state.replace([:], ticket: state.beginSnapshot()), [E2E.activityTag("a"), E2E.activityTag("b")])
        XCTAssertEqual(state.count, 0)
    }

    func testResolutionCancelsRacingReadInsteadOfReplayingIntoPartialSnapshot() {
        var state = AttentionState()
        state.replace(pending, ticket: state.beginSnapshot())
        let stale = state.beginSnapshot()
        state.receive(event(["type": "question_resolved", "sessionId": "a", "callId": "question"]))
        XCTAssertEqual(state.replace([:], ticket: stale), [])
        XCTAssertNil(state.count)
        XCTAssertEqual(state.pending, ["a", "b"])
        let fresh = state.beginSnapshot()
        state.receive(event(["type": "question", "sessionId": "new", "request": ["callId": "q", "questions": []]]))
        state.replace(pending, ticket: fresh)
        XCTAssertEqual(state.pending, ["a", "b", "new"], "new inputs still replay over a racing read")
        let beforeDismiss = state.beginSnapshot()
        state.dismiss(tag: E2E.activityTag("a"))
        state.replace([:], ticket: beforeDismiss)
        XCTAssertNil(state.count)
        XCTAssertEqual(state.pending, ["a", "b", "new"])
        state.receive(.done(sessionId: "b", messageId: nil))
        XCTAssertNil(state.count)
        state.replace([:], ticket: state.beginSnapshot())
        XCTAssertEqual(state.count, 0, "only an authoritative read removes stale rows")
    }

    func testNewestFirstApprovalsAndQuestionsNeverAssertZeroFromResolution() {
        for kind in ["approval", "question"] {
            var state = AttentionState()
            let snapshot: (String) -> JSONValue = { id in
                kind == "approval"
                    ? ["s": ["approval": ["call": ["id": .string(id), "name": "bash", "input": [:]]]]]
                    : ["s": ["question": ["callId": .string(id), "questions": []]]]
            }
            let answer: (String) -> AgentEvent = { id in
                self.event(kind == "approval"
                    ? ["type": "tool_result", "sessionId": "s", "result": ["toolCallId": .string(id), "output": "ok"]]
                    : ["type": "question_resolved", "sessionId": "s", "callId": .string(id)])
            }
            // The older request predates this connection, so only latest is known.
            state.replace(snapshot("latest"), ticket: state.beginSnapshot())
            XCTAssertEqual(state.count, 1)
            state.receive(answer("latest"))
            XCTAssertNil(state.count)
            XCTAssertEqual(state.pending, ["s"])
            state.replace(snapshot("older"), ticket: state.beginSnapshot())
            XCTAssertEqual(state.count, 1)
            state.receive(answer("older"))
            XCTAssertNil(state.count)
            state.replace([:], ticket: state.beginSnapshot())
            XCTAssertEqual(state.count, 0)
        }
    }

    func testUnknownAndFailedReconnectNeverBecomeKnownZero() {
        var state = AttentionState()
        state.replace(pending, ticket: state.beginSnapshot())
        let old = state.beginSnapshot()
        state.invalidate()
        state.replace([:], ticket: old)
        XCTAssertNil(state.count)
        state.replace(.null, ticket: state.beginSnapshot())
        XCTAssertNil(state.count)
        state.replace(["bad": ["approval": ["call": [:]]]], ticket: state.beginSnapshot())
        XCTAssertNil(state.count, "malformed input is not an empty snapshot")
        state.replace([:], ticket: state.beginSnapshot())
        XCTAssertEqual(state.count, 0)
    }

    func testOlderConcurrentReadCannotReplaceNewerRead() {
        var state = AttentionState()
        let older = state.beginSnapshot()
        let newer = state.beginSnapshot()
        state.replace(pending, ticket: newer)
        state.replace([:], ticket: older)
        XCTAssertEqual(state.count, 2)
    }

    func testManifestIsCompleteOrUnknownNeverPerRelaySubset() {
        XCTAssertEqual(PushBadgeManifest.rooms(routes: ["wss://relay.example", "wss://relay.example/"], rooms: ["b", "a", "a"], needsYou: true), ["a", "b"])
        XCTAssertEqual(PushBadgeManifest.rooms(routes: ["wss://relay.example"], rooms: ["a"], needsYou: false), [])
        XCTAssertNil(PushBadgeManifest.rooms(routes: ["wss://one.example", "wss://two.example"], rooms: ["a", "b"], needsYou: true))
        XCTAssertNil(PushBadgeManifest.rooms(routes: ["wss://one.example", "ws://local:4400"], rooms: ["a"], needsYou: true))
        XCTAssertNil(PushBadgeManifest.rooms(routes: ["wss://relay.example"], rooms: Array(repeating: "a", count: 65), needsYou: true))
        XCTAssertNil(PushBadgeManifest.rooms(routes: ["wss://relay.example"], rooms: [""], needsYou: true))
    }
}
