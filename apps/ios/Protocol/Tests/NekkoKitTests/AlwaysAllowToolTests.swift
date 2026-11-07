import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// A scripted computer that also takes signed calls: records which calls
/// came with a Change proof, and refuses `allowedMcpTools` without one, as
/// the gate does (`PHONE_GUARDED_OPTION_KEYS`).
final class SigningConnection: FakeConnection, ProofCaller, @unchecked Sendable {
    var signed: [(String, [JSONValue])] = []

    func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        if proof != nil { lock.withLock { signed.append((channel, args)) } }
        return try await answer(channel, args, signed: proof != nil, timeout: timeout)
    }

    override func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        try await answer(channel, args, signed: false, timeout: timeout)
    }

    private func answer(_ channel: String, _ args: [JSONValue], signed: Bool, timeout: TimeInterval?) async throws -> JSONValue {
        if channel == Channels.sessionSetOptions, args.dropFirst().first?["allowedMcpTools"] != nil, !signed {
            lock.withLock { calls.append((channel, args)) }
            throw RelayError("Not allowed from a paired phone (proof-required): \(channel)", fromComputer: true)
        }
        return try await super.call(channel, args, timeout: timeout)
    }

    func signedTo(_ channel: String) -> [[JSONValue]] {
        lock.withLock { signed.filter { $0.0 == channel }.map(\.1) }
    }
}

/// "Always allow this tool" on the phone (decision 0054): save, signed, then approve.
@MainActor
final class AlwaysAllowToolTests: XCTestCase {
    func makeOnline(allowed: [String] = []) async throws -> (ComputersStore, SigningConnection) {
        var conns: [SigningConnection] = []
        let session: JSONValue = ["id": "s", "title": "T", "messages": [], "queue": [],
                                  "allowedMcpTools": .array(allowed.map(JSONValue.string))]
        let s = ComputersStore(store: MemoryStore(), makeConnection: { cfg in
            let c = SigningConnection(config: cfg)
            c.replies = [
                Channels.settingsGet: { _ in ["defaultProviderId": "p", "defaultModelId": "m"] },
                Channels.sessionGet: { _ in session },
                Channels.chatPending: { _ in [:] },
            ]
            conns.append(c)
            return c
        }, deviceName: { "iPhone" }, deriveKey: { _, _ in Data(repeating: 1, count: 32) })
        s.load()
        try await s.pair(PairingLink(relayUrl: "wss://r", room: "a1b2c3d4e5f60718", key: "00112233445566778899aabbccddeeff", hostKey: testHostKey))
        s.changeSigner = SoftwareChangeSigner()
        conns[0].online()
        for _ in 0..<50 { await Task.yield() }
        try await Task.sleep(nanoseconds: 30_000_000)
        return (s, conns[0])
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 200_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func ask(_ c: FakeConnection, _ id: String, _ name: String) {
        c.event(["type": "tool_approval_required", "sessionId": "s", "call": ["id": .string(id), "name": .string(name), "input": [:]],
                 "reason": "r", "severity": "high"])
    }

    func testOnlyMcpToolsOfferIt() {
        XCTAssertTrue(ChatModel.offersAlwaysAllow(ToolCall(id: "t", name: "mcp__slack__post_message")))
        XCTAssertFalse(ChatModel.offersAlwaysAllow(ToolCall(id: "t", name: "bash")))
        XCTAssertFalse(ChatModel.offersAlwaysAllow(ToolCall(id: "t", name: "fetch_url")))
        XCTAssertFalse(ChatModel.offersAlwaysAllow(ToolCall(id: "t", name: "my_mcp__tool")))
    }

    func testSavesTheMergedListSignedThenApproves() async throws {
        let (s, c) = try await makeOnline(allowed: ["mcp__github__create_issue"])
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        XCTAssertEqual(chat.allowedMcpTools, ["mcp__github__create_issue"], "read from the session")
        ask(c, "t1", "mcp__slack__post_message")
        await settle()
        try await chat.alwaysAllowTool()
        XCTAssertNil(chat.turn.approval)
        let list: JSONValue = ["mcp__github__create_issue", "mcp__slack__post_message"]
        XCTAssertEqual(c.signedTo(Channels.sessionSetOptions), [["s", ["allowedMcpTools": list]]], "the save carries a Change proof")
        XCTAssertEqual(c.callsTo(Channels.toolApprove), [["s", "t1", true]])
        // Saved before the call is released, and never as YOLO.
        let order = c.calls.map(\.0).filter { $0 == Channels.sessionSetOptions || $0 == Channels.toolApprove }
        XCTAssertEqual(order.last, Channels.toolApprove)
        XCTAssertEqual(order.first, Channels.sessionSetOptions)
        XCTAssertFalse(c.callsTo(Channels.sessionSetOptions).contains { $0.dropFirst().first?["mode"] != nil })
        XCTAssertTrue(c.signedTo(Channels.toolApprove).isEmpty, "approving needs no proof")

        // A second tool in the same turn keeps the first one, before the chat is read again.
        ask(c, "t2", "mcp__notion__search")
        await settle()
        try await chat.alwaysAllowTool()
        XCTAssertEqual(c.signedTo(Channels.sessionSetOptions).last,
                       ["s", ["allowedMcpTools": ["mcp__github__create_issue", "mcp__slack__post_message", "mcp__notion__search"]]])
        // The same tool again is not listed twice.
        ask(c, "t3", "mcp__notion__search")
        await settle()
        try await chat.alwaysAllowTool()
        XCTAssertEqual(c.signedTo(Channels.sessionSetOptions).last?.dropFirst().first?["allowedMcpTools"]?.array?.count, 3)
        chat.stop()
    }

    func testAFailedSaveApprovesNothingAndKeepsTheCard() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        ask(c, "t", "mcp__slack__post_message")
        await settle()
        c.replies[Channels.sessionSetOptions] = { _ in throw RelayError("Not allowed from a paired phone (change-off): session:setOptions", fromComputer: true) }
        do { try await chat.alwaysAllowTool(); XCTFail("expected a refusal") } catch {
            XCTAssertTrue(error.localizedDescription.contains("Changes from this phone are turned off"), error.localizedDescription)
        }
        XCTAssertTrue(c.callsTo(Channels.toolApprove).isEmpty, "not saved, so not approved")
        XCTAssertEqual(chat.turn.approval?.call.id, "t", "the computer is still waiting, so the card stays")
        chat.stop()
    }

    func testAFailedApproveKeepsTheCard() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        ask(c, "t", "mcp__slack__post_message")
        await settle()
        c.replies[Channels.toolApprove] = { _ in throw RelayError("offline") }
        do { try await chat.alwaysAllowTool(); XCTFail("expected a failure") } catch {}
        XCTAssertEqual(chat.turn.approval?.call.id, "t")
        chat.stop()
    }

    func testNotForOtherToolsNorOffline() async throws {
        let (s, c) = try await makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        ask(c, "t", "bash")
        await settle()
        do { try await chat.alwaysAllowTool(); XCTFail("only MCP tools") } catch {}
        XCTAssertEqual(chat.turn.approval?.call.id, "t")
        XCTAssertTrue(c.callsTo(Channels.sessionSetOptions).isEmpty)
        XCTAssertTrue(c.callsTo(Channels.toolApprove).isEmpty)

        ask(c, "t2", "mcp__slack__post_message")
        await settle()
        c.status(RelayStatus(.offline))
        await settle()
        do { try await chat.alwaysAllowTool(); XCTFail("never sent later") } catch {
            XCTAssertEqual(error.localizedDescription, ChatModel.reconnectToAnswer)
        }
        XCTAssertTrue(c.callsTo(Channels.sessionSetOptions).isEmpty)
        chat.stop()
    }

    func testTheYoloWarningShowsOnlyWhenTurningYoloOn() {
        XCTAssertTrue(YoloWarning.needed(from: .guardrails, to: .yolo, skipped: false))
        XCTAssertTrue(YoloWarning.needed(from: .ask, to: .yolo, skipped: false))
        XCTAssertTrue(YoloWarning.needed(from: nil, to: .yolo, skipped: false))
        XCTAssertFalse(YoloWarning.needed(from: .yolo, to: .yolo, skipped: false), "already YOLO")
        XCTAssertFalse(YoloWarning.needed(from: .yolo, to: .guardrails, skipped: false))
        XCTAssertFalse(YoloWarning.needed(from: .ask, to: .guardrails, skipped: false))
        XCTAssertFalse(YoloWarning.needed(from: .guardrails, to: .yolo, skipped: true), "Don't warn me again")
        XCTAssertEqual(YoloWarning.skipKey, "skipYoloWarning")
    }
}
