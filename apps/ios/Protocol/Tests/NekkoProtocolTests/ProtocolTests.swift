import Foundation
import XCTest
@testable import NekkoProtocol

final class E2ETests: XCTestCase {
    struct Vector: Decodable {
        let secret, room, keyHex, ivHex, plaintext, sealed: String
    }

    /// The fixture was produced by WebCrypto (the agent's API), shared with Android.
    func vector() throws -> Vector {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "e2e-vector", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    func testDerivesTheSameKeyAsWebCrypto() throws {
        let v = try vector()
        XCTAssertEqual(E2E.toHex(E2E.deriveKey(secret: v.secret, room: v.room)), v.keyHex)
    }

    func testSealsByteIdenticallyToWebCrypto() throws {
        let v = try vector()
        let key = try XCTUnwrap(E2E.fromHex(v.keyHex))
        XCTAssertEqual(try E2E.sealText(key: key, plaintext: v.plaintext, iv: E2E.fromHex(v.ivHex)), v.sealed)
        XCTAssertEqual(try E2E.openText(key: key, blob: v.sealed), v.plaintext)
    }

    func testRejectsAWrongKeyAndTampering() throws {
        let v = try vector()
        let key = try XCTUnwrap(E2E.fromHex(v.keyHex))
        XCTAssertThrowsError(try E2E.openText(key: E2E.randomBytes(32), blob: v.sealed))
        var bytes = try XCTUnwrap(Data(base64Encoded: v.sealed))
        bytes[20] ^= 0x01
        XCTAssertThrowsError(try E2E.openText(key: key, blob: bytes.base64EncodedString()))
        XCTAssertThrowsError(try E2E.openText(key: key, blob: "AAAA"))
        XCTAssertThrowsError(try E2E.sealText(key: Data(count: 16), plaintext: "x"))
    }

    func testRoundTripsJSONWithFreshIVs() throws {
        let key = E2E.randomBytes(32)
        let v: JSONValue = ["type": "req", "id": 3, "args": ["héllo ✓ 🐱", 1.5, true, nil]]
        let a = try E2E.seal(key: key, value: v)
        let b = try E2E.seal(key: key, value: v)
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(try E2E.open(key: key, blob: a), v)
    }

    /// Pinned to the computer's golden (crates/nekko-remote/tests/golden/agent.json).
    func testActivityTagMatchesTheComputers() {
        XCTAssertEqual(E2E.activityTag("s1"), "7536af24f84b356f893a72f0def58cce")
        XCTAssertEqual(E2E.activityTag("s2"), "c999df987ff9835d74f4acf7bae0b592")
    }

    func testHex() {
        XCTAssertEqual(E2E.toHex(Data([0, 1, 0xab, 0xff])), "0001abff")
        XCTAssertEqual(E2E.fromHex("0001ABff"), Data([0, 1, 0xab, 0xff]))
        XCTAssertNil(E2E.fromHex("abc"))
        XCTAssertNil(E2E.fromHex("zz"))
    }
}

final class JSONValueTests: XCTestCase {
    func testParsesAndSerializes() throws {
        let v = try JSONValue.parse(#"{"a":[1,2.5,"x\n\"y",true,null],"b":{"c":-7}}"#)
        XCTAssertEqual(v["a"]?.array?.count, 5)
        XCTAssertEqual(v["a"]?.array?[0], .int(1))
        XCTAssertEqual(v["a"]?.array?[1], .double(2.5))
        XCTAssertEqual(v["a"]?.array?[3], .bool(true))
        XCTAssertEqual(v["b"]?.long("c"), -7)
        XCTAssertEqual(v.serialized(), #"{"a":[1,2.5,"x\n\"y",true,null],"b":{"c":-7}}"#)
        XCTAssertEqual(try JSONValue.parse(v.serialized()), v)
        XCTAssertEqual(JSONValue.string("\u{01}").serialized(), "\"\\u0001\"")
    }

    func testJSNumbersReadAsIntegers() throws {
        XCTAssertEqual(try JSONValue.parse("1760000000000.0").int64, 1_760_000_000_000)
        XCTAssertEqual(JSONValue.double(3).serialized(), "3")
    }
}

final class PairingTests: XCTestCase {
    let room = "a1b2c3d4e5f60718"
    let key = "00112233445566778899aabbccddeeff"

    func testParsesTheSchemeTheWebFormAndABareQuery() {
        let forms = [
            "nekko-agent-pair:?relay=wss%3A%2F%2Frelay.example.com%2F&room=\(room)&key=\(key)&pair=abcd2345",
            "https://host.example.com/?relay=wss://relay.example.com&room=\(room)&key=\(key)&pair=ABCD2345#x",
            "  relay=wss://relay.example.com&room=\(room)&key=\(key)&pair=ABCD2345\n",
        ]
        for f in forms {
            XCTAssertEqual(Pairing.parse(f), PairingLink(relayUrl: "wss://relay.example.com", room: room, key: key, pair: "ABCD2345"), f)
        }
    }

    func testPairCodeIsOptionalAndFirstValueWins() {
        let l = Pairing.parse("relay=ws://studio.tail1234.ts.net:4400&room=\(room)&room=ffffffff&key=\(key)&pair=")
        XCTAssertEqual(l?.room, room)
        XCTAssertNil(l?.pair)
        XCTAssertEqual(l.map { Pairing.relayHost($0.relayUrl) }, "studio.tail1234.ts.net:4400")
    }

    func testRejectsMalformedLinks() {
        XCTAssertNil(Pairing.parse(""))
        XCTAssertNil(Pairing.parse("relay=https://x&room=\(room)&key=\(key)"))
        XCTAssertNil(Pairing.parse("relay=wss://x&room=xyz&key=\(key)"))
        XCTAssertNil(Pairing.parse("relay=wss://x&room=\(room)&key=short"))
        XCTAssertNil(Pairing.parse("relay=wss://x&room=\(room)"))
        XCTAssertNil(Pairing.parse("relay=wss://x&room=%ZZ&key=\(key)"))
    }

    func testNeverPrintsTheSecret() {
        let l = PairingLink(relayUrl: "wss://r", room: room, key: key, pair: "ABCD2345")
        XCTAssertFalse(String(describing: l).contains(key))
        XCTAssertFalse(String(describing: l).contains("ABCD2345"))
    }
}

final class RelayRouteTests: XCTestCase {
    func testClassifiesRoutes() {
        XCTAssertEqual(RelayRoute.of("ws://studio.tail1234.ts.net:4400"), .tailscale)
        XCTAssertEqual(RelayRoute.of("wss://studio.tail1234.ts.net"), .tailscale)
        XCTAssertEqual(RelayRoute.of("ws://100.101.102.103:4400"), .tailscale)
        XCTAssertEqual(RelayRoute.of("ws://100.128.0.1:4400"), .internet)
        XCTAssertEqual(RelayRoute.of("ws://[fd7a:115c:a1e0::1]:4400"), .tailscale)
        XCTAssertEqual(RelayRoute.of("ws://192.168.1.20:4400"), .lan)
        XCTAssertEqual(RelayRoute.of("ws://10.0.0.5:4400"), .lan)
        XCTAssertEqual(RelayRoute.of("ws://172.20.1.1:4400"), .lan)
        XCTAssertEqual(RelayRoute.of("ws://172.32.1.1:4400"), .internet)
        XCTAssertEqual(RelayRoute.of("ws://studio.local:4400"), .lan)
        XCTAssertEqual(RelayRoute.of("ws://[fe80::1]:4400"), .lan)
        XCTAssertEqual(RelayRoute.of("ws://localhost:4400"), .loopback)
        XCTAssertEqual(RelayRoute.of("ws://127.0.0.1:4400"), .loopback)
        XCTAssertEqual(RelayRoute.of("wss://relay.nekkoagent.com"), .internet)
        XCTAssertEqual(RelayRoute.of("wss://evil.ts.net.example.com"), .internet)
    }

    func testOnlyEncryptedRelaysOnTheOpenInternet() {
        XCTAssertNil(RelayRoute.problem("wss://relay.nekkoagent.com", simulator: false))
        XCTAssertEqual(RelayRoute.problem("ws://relay.nekkoagent.com", simulator: false), .publicCleartext)
        XCTAssertEqual(RelayRoute.problem("ws://8.8.8.8:4400", simulator: false), .publicCleartext)
        XCTAssertNil(RelayRoute.problem("ws://studio.tail1234.ts.net:4400", simulator: false))
        XCTAssertNil(RelayRoute.problem("ws://192.168.1.20:4400", simulator: false))
        XCTAssertEqual(RelayRoute.problem("ws://localhost:4400", simulator: false), .loopback)
        XCTAssertNil(RelayRoute.problem("ws://localhost:4400", simulator: true))
    }

    func testDetectsATailnetAddress() {
        XCTAssertTrue(Tailnet.isConnected(addresses: ["127.0.0.1", "192.168.1.4", "100.88.1.2"]))
        XCTAssertFalse(Tailnet.isConnected(addresses: ["127.0.0.1", "192.168.1.4"]))
        XCTAssertFalse(Tailnet.deviceAddresses().isEmpty) // loopback at least
    }
}

final class WireTests: XCTestCase {
    /// The channels the phone calls are exactly the ones the computer lets a phone call.
    func testChannelsMatchTheComputersPhoneAllowList() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shared/src/phone-access.ts")
        guard let src = try? String(contentsOf: file, encoding: .utf8) else {
            throw XCTSkip("repository sources not available at \(file.path)")
        }
        let start = try XCTUnwrap(src.range(of: "export const PHONE_CHANNELS = ["))
        let end = try XCTUnwrap(src.range(of: "]", range: start.upperBound..<src.endIndex))
        let list = src[start.upperBound..<end.lowerBound]
            .split(separator: ",").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \n'\"")) }.filter { !$0.isEmpty }
        XCTAssertEqual(Set(Channels.all), Set(list))
    }

    func testDecodesAPhoneSession() throws {
        let raw = try JSONValue.parse("""
        {"id":"s1","title":"Fix it","providerId":"p","modelId":"m","workspaceId":"w","omittedMessages":12,
         "queue":["next",{"text":"then this","images":["data:"]}],"updatedAt":1760000000000,
         "messages":[
          {"id":"u1","role":"user","content":"hi","createdAt":1,"images":["a","b"]},
          {"id":"a1","role":"assistant","content":"Running it","toolCalls":[{"id":"t1","name":"bash","input":{"command":"ls -la"}}]},
          {"id":"r1","role":"tool","toolResult":{"toolCallId":"t1","output":"abc","isError":false,"truncated":true,"outputChars":9000,"omittedImages":2}},
          {"id":"u2","role":"user","content":"","skill":{"name":"review","input":"the diff"}}
         ]}
        """)
        let s = try XCTUnwrap(Session.from(raw))
        XCTAssertEqual(s.queue, ["next", "then this"])
        XCTAssertEqual(s.omittedMessages, 12)
        XCTAssertEqual(s.messages[0].imageCount, 2)
        XCTAssertEqual(s.messages[2].toolResult?.outputChars, 9000)
        let blocks = Transcript.fromMessages(s.messages)
        XCTAssertEqual(blocks.count, 4)
        guard case .tool(_, _, let label, .ok, let output?) = blocks[2] else { return XCTFail("\(blocks[2])") }
        XCTAssertEqual(label, "Run ls -la")
        XCTAssertEqual(output, "abc\n… (8997 more characters, on the computer)\n2 images, on the computer")
        XCTAssertEqual(Transcript.splitNotes(output).0, "abc")
        XCTAssertEqual(Transcript.splitNotes(output).1.count, 2)
        guard case .user(_, let text, _, _) = blocks[3] else { return XCTFail() }
        XCTAssertEqual(text, "/review the diff")
    }

    func testSummariesGroupLikeTheDesktopSidebar() throws {
        let raw = try JSONValue.parse("""
        [{"id":"a","title":"A","updatedAt":5},
         {"id":"b","title":"B","updatedAt":9,"workspaceId":"w1","order":2},
         {"id":"c","title":"C","updatedAt":3,"workspaceId":"w1","order":1},
         {"id":"d","title":"D","updatedAt":7,"workspaceId":"w1"},
         {"id":"e","title":"E","updatedAt":8,"workspaceId":"w1","archivedAt":100},
         {"id":"f","title":"F","updatedAt":9,"parentSessionId":"a"},
         {"id":"g","title":"G","updatedAt":1,"workspaceId":"gone"}]
        """)
        let list = SessionSummary.visible(raw)
        XCTAssertEqual(list.map(\.id), ["b", "e", "d", "a", "c", "g"])
        let groups = ChatGroup.of(list, folders: [WorkspaceFolder(id: "w1", name: "App"), WorkspaceFolder(id: "w2", name: "Empty")])
        XCTAssertEqual(groups.map(\.name), ["General", "App", "Empty"])
        XCTAssertEqual(groups[0].active.map(\.id), ["a", "g"])
        XCTAssertEqual(groups[1].active.map(\.id), ["c", "b", "d"])
        XCTAssertEqual(groups[1].completed.map(\.id), ["e"])
        XCTAssertTrue(groups[2].active.isEmpty)
    }

    func testKeepsSecretsOutOfProjections() throws {
        let p = PublicProvider.list(try JSONValue.parse(#"[{"id":"o","kind":"openai","label":"OpenAI","enabled":true,"apiKey":"sk-x"}]"#))
        XCTAssertEqual(p, [PublicProvider(id: "o", kind: "openai", label: "OpenAI", enabled: true)])
        let settings = try JSONValue.parse(##"{"defaultProviderId":"o","defaultModelId":"m","favoriteModels":["o::m",3],"theme":"dark","accent":"#ff8800","themePreset":"Bad Preset","defaultChatMode":"yolo","voice":{"enabled":true}}"##)
        XCTAssertEqual(RemoteDefaults.from(settings), RemoteDefaults(defaultProviderId: "o", defaultModelId: "m", favoriteModels: ["o::m"]))
        XCTAssertEqual(Appearance.from(settings), Appearance(theme: .dark, preset: nil, accent: 0xff8800))
        let pc = PcSettings.from(settings)
        XCTAssertEqual(pc.effectiveMode, .yolo)
        XCTAssertTrue(pc.voiceEnabled)
        XCTAssertTrue(pc.known)
        XCTAssertEqual(PcSettings.patch(mode: .ask), ["defaultChatMode": "ask"])
    }

    func testDecodesEventsAndPending() throws {
        let ev = try JSONValue.parse(#"{"type":"tool_approval_required","sessionId":"s","call":{"id":"t","name":"bash","input":{"command":"rm -rf /"}},"reason":"Deletes files","severity":"high"}"#)
        guard case .approvalRequired("s", let a)? = AgentEvent.from(ev) else { return XCTFail() }
        XCTAssertEqual(a.severity, .high)
        XCTAssertEqual(AgentEvent.from(try JSONValue.parse(#"{"type":"brand_new","sessionId":"s"}"#)), .other(sessionId: "s", type: "brand_new"))
        XCTAssertNil(AgentEvent.from(try JSONValue.parse(#"{"type":"text"}"#)))
        let pending = PendingInput.map(try JSONValue.parse("""
        {"s1":{"question":{"callId":"q","askedAt":5,"questions":[{"id":"x","header":"H","question":"Which?","multiSelect":true,"options":[{"label":"A"},{"label":"B","description":"b"}]}]}},
         "s2":{"approval":{"call":{"id":"t","name":"write_file","input":{"path":"a.txt"}},"reason":"r","severity":"medium"}}}
        """))
        XCTAssertEqual(pending["s1"]?.question?.questions.first?.options.count, 2)
        XCTAssertEqual(pending["s2"]?.approval?.severity, .medium)
        XCTAssertEqual(AskAnswer(questionId: "x", labels: ["A"], note: "  ").json, ["questionId": "x", "labels": ["A"]])
    }

    func testBuildsSendAndQueueArgumentsWithinThePhoneKeys() {
        let skill = SkillSummary(name: "review")
        let send = sendOptions(sessionId: "s", providerId: "p", modelId: "m", text: "go", skill: skill, images: ["data:image/jpeg;base64,AA"])
        let allowed: Set<String> = ["images", "modelId", "providerId", "regenerate", "resume", "sessionId", "skill", "text"]
        XCTAssertTrue(Set(send.object!.keys).isSubset(of: allowed))
        XCTAssertEqual(send["skill"], ["name": "review", "input": "go"])
        XCTAssertEqual(queuePrompt(text: "later"), "later")
        XCTAssertEqual(queuePrompt(text: "later", skill: skill)["skill"]?.str("name"), "review")
    }
}

final class TranscriptTests: XCTestCase {
    func call(_ id: String, _ name: String = "bash", _ input: [String: JSONValue] = ["command": "ls"]) -> ToolCall {
        ToolCall(id: id, name: name, input: input)
    }

    func testFoldsAStreamedTurn() {
        var t = LiveTurn(running: true, blocks: [.user(id: "p", text: "go", at: 1, images: 0)])
        t = Transcript.apply(t, .reasoning(sessionId: "s", delta: "think"))
        t = Transcript.apply(t, .text(sessionId: "s", delta: "Hel"))
        t = Transcript.apply(t, .text(sessionId: "s", delta: "lo"))
        t = Transcript.apply(t, .toolCall(sessionId: "s", call: call("t1")))
        t = Transcript.apply(t, .approvalRequired(sessionId: "s", approval: Approval(call: call("t1"), reason: "r", severity: .low)))
        XCTAssertNotNil(t.approval)
        t = Transcript.apply(t, .toolResult(sessionId: "s", result: ToolResult(toolCallId: "t1", output: "ok", isError: false, outputChars: nil, omittedImages: 0)))
        XCTAssertNil(t.approval)
        t = Transcript.apply(t, .text(sessionId: "s", delta: "Done"))
        t = Transcript.apply(t, .usage(sessionId: "s", outputTokens: 100, outputMs: 2000))
        t = Transcript.apply(t, .done(sessionId: "s", messageId: "m"))
        XCTAssertFalse(t.running)
        XCTAssertEqual(t.rate, 50)
        XCTAssertEqual(t.blocks.count, 4)
        guard case .assistant(_, "Hello", "think", false, _) = t.blocks[1] else { return XCTFail("\(t.blocks[1])") }
        guard case .tool("t1", _, "Run ls", .ok, "ok") = t.blocks[2] else { return XCTFail("\(t.blocks[2])") }
        guard case .assistant(_, "Done", nil, false, _) = t.blocks[3] else { return XCTFail("\(t.blocks[3])") }
    }

    func testRetryDropsRegeneratedTextAndStopIsNotAnError() {
        var t = LiveTurn(running: true, blocks: [.user(id: "p", text: "go", at: 1, images: 0)])
        t = Transcript.apply(t, .text(sessionId: "s", delta: "partial"))
        t = Transcript.apply(t, .retry(sessionId: "s"))
        XCTAssertEqual(t.blocks.count, 1)
        t = Transcript.apply(t, .error(sessionId: "s", message: "Stopped"))
        XCTAssertNil(t.error)
        XCTAssertEqual(Transcript.apply(t, .error(sessionId: "s", message: "rate limited")).error, "rate limited")
    }

    func testMergesLiveIntoSavedWithoutDuplicates() {
        let saved: [Block] = [
            .user(id: "u0", text: "earlier", at: 0, images: 0),
            .assistant(id: "a0", text: "Same words", reasoning: nil, streaming: false, interrupted: false),
            .user(id: "u1", text: "go", at: 1, images: 0),
            .tool(id: "t1", name: "bash", label: "Run ls", status: .ok, output: nil),
        ]
        let live: [Block] = [
            .user(id: "p", text: " go ", at: 1, images: 0),
            .tool(id: "t1", name: "bash", label: "Run ls", status: .ok, output: "files"),
            .assistant(id: "l", text: "Same words", reasoning: nil, streaming: true, interrupted: false),
        ]
        let merged = Transcript.mergeLive(saved: saved, live: live)
        XCTAssertEqual(merged.map(\.id), ["u0", "a0", "u1", "t1", "l"])
        guard case .tool(_, _, _, _, "files") = merged[3] else { return XCTFail() }
        // A prompt the saved transcript doesn't hold yet is appended whole.
        XCTAssertEqual(Transcript.mergeLive(saved: Array(saved.prefix(2)), live: live).count, 5)
    }

    func testToolLabelsAndActivity() {
        XCTAssertEqual(Transcript.toolLabel(call("1", "read_file", ["path": "src/a.ts"])), "Read src/a.ts")
        XCTAssertEqual(Transcript.toolLabel(call("1", "custom_tool", [:])), "custom tool")
        XCTAssertEqual(Transcript.toolLabel(call("1", "bash", ["command": "echo   a\n b"])), "Run echo a b")
        var a: [String: Activity] = [:]
        a = ActivityTracker.next(a, .text(sessionId: "s", delta: "x"))
        XCTAssertEqual(a["s"], .running)
        a = ActivityTracker.next(a, .question(sessionId: "s", request: AskRequest(callId: "q", questions: [], askedAt: 0)))
        XCTAssertEqual(a["s"], .needsYou)
        a = ActivityTracker.next(a, .done(sessionId: "s", messageId: nil))
        XCTAssertNil(a["s"])
    }
}
