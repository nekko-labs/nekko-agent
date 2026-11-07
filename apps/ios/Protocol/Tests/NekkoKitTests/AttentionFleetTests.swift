import Foundation
import XCTest
@testable import NekkoKit
import NekkoProtocol

extension FleetTests {
    func testAttentionCountsEveryComputerAndKeepsPendingWhenOpened() async throws {
        let s = makeStore()
        XCTAssertNil(s.attentionCount)
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.replies[Channels.chatPending] = { _ in ["aaaa1": ["question": ["callId": "q", "questions": []]]] }
        ca.online()
        await settle()
        XCTAssertEqual(s.attentionCount, 1)
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        XCTAssertNil(s.attentionCount, "one unread paired computer prevents a partial local badge")
        cb.replies[Channels.chatPending] = { _ in [:] }
        cb.online()
        await settle()
        XCTAssertEqual(s.attentionCount, 1)
        var notified: [String] = []
        s.onComputerEvent = { id, _ in notified.append(id) }
        ca.event(["type": "question", "sessionId": "aaaa2", "request": ["callId": "q2", "questions": []]])
        cb.event(["type": "question", "sessionId": "bbbb1", "request": ["callId": "q3", "questions": []]])
        await settle()
        XCTAssertEqual(Set(notified), [a, b], "native notifications receive both active and fleet events")
        XCTAssertEqual(s.fleetNeedsYouCount, 3)
        XCTAssertEqual(s.attentionCount, 3)
        // Preserve the pending read as the chat opens and the link is adopted.
        ca.replies[Channels.chatPending] = { _ in ["aaaa1": ["question": ["callId": "q", "questions": []]],
                                                     "aaaa2": ["question": ["callId": "q2", "questions": []]]] }
        s.focus(chat: "aaaa2")
        XCTAssertEqual(s.attentionCount, 3, "opening is not resolving")
        await settle()
        XCTAssertEqual(s.attentionCount, 3)
        cb.replies[Channels.chatPending] = { _ in [:] }
        cb.control(.dismiss(tag: E2E.activityTag("bbbb1")))
        await settle()
        XCTAssertEqual(s.attentionCount, 2, "remote fleet dismiss updates the reducer, not only notification center")
        ca.replies[Channels.chatPending] = { _ in ["aaaa1": ["question": ["callId": "q", "questions": []]]] }
        ca.event(["type": "question_resolved", "sessionId": "aaaa2", "callId": "q2"])
        await settle()
        XCTAssertEqual(s.attentionCount, 1)
        ca.replies[Channels.chatPending] = { _ in [:] }
        s.reconnect()
        XCTAssertNil(s.attentionCount)
        ca.online()
        await settle()
        XCTAssertEqual(s.attentionCount, 0, "reconnect replaces old entries")
        cb.status(RelayStatus(.offline))
        await settle()
        XCTAssertNil(s.attentionCount)
        s.forget(b)
        XCTAssertEqual(s.attentionCount, 0)
    }

    func testNewestFirstResolutionRetainsNeedsYouAndRejectsStaleReadsOnActiveAndFleet() async throws {
        for fleet in [false, true] {
            for kind in ["approval", "question"] {
                secure = MemoryStore()
                connections = []
                let s = makeStore()
                s.load()
                let a = try await s.pair(link("aaaa"))
                let ca = try XCTUnwrap(connections.last)
                let pending: (String) -> JSONValue = { id in
                    kind == "approval"
                        ? ["aaaa1": ["approval": ["call": ["id": .string(id), "name": "bash", "input": [:]]]]]
                        : ["aaaa1": ["question": ["callId": .string(id), "questions": []]]]
                }
                let answer: (String) -> JSONValue = { id in
                    kind == "approval"
                        ? ["type": "tool_result", "sessionId": "aaaa1", "result": ["toolCallId": .string(id), "output": "ok"]]
                        : ["type": "question_resolved", "sessionId": "aaaa1", "callId": .string(id)]
                }
                // Both requests already exist on the host; only newest is exposed.
                ca.replies[Channels.chatPending] = { _ in pending("latest") }
                ca.online()
                await settle()
                if fleet {
                    _ = try await s.pair(link("bbbb"))
                    let cb = try XCTUnwrap(connections.last)
                    cb.replies[Channels.chatPending] = { _ in [:] }
                    cb.online()
                    await settle()
                }
                XCTAssertEqual(s.attentionCount, 1)
                var dismissed: [String] = []
                s.onDismiss = { dismissed.append($0) }
                var reads: [CheckedContinuation<JSONValue, Error>] = []
                ca.pendingReply = {
                    try await withCheckedThrowingContinuation { reads.append($0) }
                }
                let stale = Task {
                    if fleet { await s.refreshPeer(a) } else { await s.refreshAttention() }
                }
                await settle()
                XCTAssertEqual(reads.count, 1)
                ca.event(answer("latest"))
                await settle()
                XCTAssertEqual(reads.count, 2, "every resolution starts a new pending read")
                XCTAssertNil(s.attentionCount, "no authoritative local zero while a read is outstanding")
                XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
                XCTAssertTrue(dismissed.isEmpty)
                // Fresh response reveals older without any new required event.
                try XCTUnwrap(reads.dropFirst().first).resume(returning: pending("older"))
                await settle()
                XCTAssertEqual(s.attentionCount, 1)
                try XCTUnwrap(reads.first).resume(returning: [:])
                await stale.value
                XCTAssertEqual(s.attentionCount, 1, "an older ready zero cannot replace the newer input")
                XCTAssertTrue(dismissed.isEmpty)

                ca.control(.dismiss(tag: E2E.activityTag("aaaa1")))
                await settle()
                XCTAssertEqual(reads.count, 3)
                XCTAssertNil(s.attentionCount)
                XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
                XCTAssertTrue(dismissed.isEmpty, "legacy dismiss must not remove needs-you notifications")
                try XCTUnwrap(reads.dropFirst(2).first).resume(throwing: RelayError("unavailable"))
                await settle()
                XCTAssertNil(s.attentionCount)
                XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
                XCTAssertTrue(dismissed.isEmpty)

                ca.event(answer("unobserved"))
                await settle()
                XCTAssertEqual(reads.count, 4, "even a nonmatching resolution re-reads the full map")
                try XCTUnwrap(reads.dropFirst(3).first).resume(returning: pending("older"))
                await settle()
                XCTAssertEqual(s.attentionCount, 1)
                XCTAssertTrue(dismissed.isEmpty)
                ca.event(answer("older"))
                await settle()
                XCTAssertEqual(reads.count, 5)
                XCTAssertNil(s.attentionCount)
                XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
                try XCTUnwrap(reads.dropFirst(4).first).resume(returning: [:])
                await settle()
                XCTAssertEqual(s.attentionCount, 0)
                XCTAssertNotEqual(s.activity(on: a)["aaaa1"], .needsYou)
                XCTAssertEqual(dismissed, [E2E.activityTag("aaaa1")], "dismiss notifications only after confirming every input is answered")
                ca.pendingReply = nil
                s.disconnect()
            }
        }
    }

    /// The phone was away when a question was answered there: the resolving event
    /// never reached it, so the reconnect read alone must clear the chat's row.
    func testReconnectReadClearsNeedsYouThePhoneMissedOnActiveAndFleet() async throws {
        for fleet in [false, true] {
            secure = MemoryStore()
            connections = []
            let s = makeStore()
            s.load()
            let a = try await s.pair(link("aaaa"))
            let ca = try XCTUnwrap(connections.last)
            ca.replies[Channels.chatPending] = { _ in [:] }
            ca.online()
            await settle()
            if fleet {
                _ = try await s.pair(link("bbbb"))
                let cb = try XCTUnwrap(connections.last)
                cb.replies[Channels.chatPending] = { _ in [:] }
                cb.online()
                await settle()
            }
            ca.event(["type": "question", "sessionId": "aaaa1", "request": ["callId": "q", "questions": []]])
            await settle()
            XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
            // Away: answered on the computer, and the phone never hears of it.
            ca.status(RelayStatus(.connecting))
            await settle()
            ca.online()
            await settle()
            XCTAssertNil(s.activity(on: a)["aaaa1"], "nothing waits there any more")
            XCTAssertEqual(s.attentionCount, 0)
            s.disconnect()
        }
    }

    func testResolutionReadFromOldLinkCannotDismissAfterReconnect() async throws {
        for fleet in [false, true] {
            secure = MemoryStore()
            connections = []
            let s = makeStore()
            s.load()
            let a = try await s.pair(link("aaaa"))
            let old = try XCTUnwrap(connections.last)
            old.replies[Channels.chatPending] = { _ in ["aaaa1": ["question": ["callId": "latest", "questions": []]]] }
            old.online()
            await settle()
            if fleet {
                _ = try await s.pair(link("bbbb"))
                let cb = try XCTUnwrap(connections.last)
                cb.replies[Channels.chatPending] = { _ in [:] }
                cb.online()
                await settle()
            }
            var dismissed: [String] = []
            s.onDismiss = { dismissed.append($0) }
            var reply: CheckedContinuation<JSONValue, Error>?
            old.pendingReply = { try await withCheckedThrowingContinuation { reply = $0 } }
            old.event(["type": "question_resolved", "sessionId": "aaaa1", "callId": "latest"])
            await settle()
            XCTAssertNil(s.attentionCount)
            XCTAssertNotNil(reply)
            if fleet { s.reconnect(computer: a) } else { s.connect(a) }
            let fresh = try XCTUnwrap(connections.last)
            XCTAssertFalse(fresh === old)
            fresh.replies[Channels.chatPending] = { _ in ["aaaa1": ["question": ["callId": "older", "questions": []]]] }
            fresh.online()
            await settle()
            XCTAssertEqual(s.attentionCount, 1)
            try XCTUnwrap(reply).resume(returning: [:])
            await settle()
            XCTAssertEqual(s.attentionCount, 1)
            XCTAssertEqual(s.activity(on: a)["aaaa1"], .needsYou)
            XCTAssertTrue(dismissed.isEmpty)
            fresh.replies[Channels.chatPending] = { _ in [:] }
            fresh.event(["type": "question_resolved", "sessionId": "aaaa1", "callId": "older"])
            await settle()
            XCTAssertEqual(s.attentionCount, 0)
            XCTAssertEqual(dismissed, [E2E.activityTag("aaaa1")])
            old.pendingReply = nil
            s.disconnect()
        }
    }

    func testPushEnrollsWholePairedManifestEvenWhenAnotherComputerIsOffline() async throws {
        let s = makeStore()
        s.load()
        _ = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        await settle()
        s.setPushToken("token")
        await settle()
        XCTAssertEqual(ca.badgeManifests.last!, ["aaaa"])
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        await settle()
        XCTAssertEqual(ca.badgeManifests.last!, ["aaaa", "bbbb"], "offline rooms remain required, not a known-zero omission")
        cb.online()
        await settle()
        XCTAssertEqual(cb.badgeManifests.last!, ["aaaa", "bbbb"])
        s.pushKinds = [.finished]
        await settle()
        XCTAssertEqual(cb.badgeManifests.last!, [])
        s.forget(b)
        s.pushKinds = [.needsYou]
        await settle()
        XCTAssertEqual(ca.badgeManifests.last!, ["aaaa"])
        _ = try await s.pair(PairingLink(relayUrl: "wss://different.example", room: "cccc", key: key, hostKey: testHostKey, pair: nil))
        connections.last?.online()
        await settle()
        XCTAssertNil(s.pushBadgeRooms)
        XCTAssertNil(connections.last?.badgeManifests.last!, "different relays receive no fabricated partial authority")
    }
}
