#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Real ChatView against an in-memory computer. This fixture can be copied
/// unchanged to an exact base revision for matching native before/after shots.
/// No sockets, provider requests, secrets or transcript files are used.
struct TurnDetailsFixture: View {
    @State private var store = ComputersStore(
        store: TurnDetailsFixtureSecrets(), makeConnection: { _ in TurnDetailsFixtureConnection() },
        deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) })
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ready { ChatView(sessionId: "turn-details-fixture") }
        }
        .environment(store)
        .overlay(alignment: .topLeading) { TurnDetailsProbeReadout() }
        .task {
            store.load()
            _ = try? await store.pair(PairingLink(relayUrl: "ws://localhost:1440", room: "a1b2c3d4e5f60718",
                                                key: "00112233445566778899aabbccddeeff",
                                                hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=", pair: "ABCD2345"))
            ready = true
        }
    }
}

private final class TurnDetailsFixtureSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class TurnDetailsFixtureConnection: RemoteConnection, @unchecked Sendable {
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {}
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        guard channel == Channels.sessionGet else { return .null }
        let flags = ProcessInfo.processInfo.arguments
        var stats: [String: JSONValue] = [
            "providerId": "used-provider", "modelId": "used-model", "effort": "high",
            "inputTokens": 1000, "cacheReadTokens": 200, "cacheWriteTokens": 100,
            "outputTokens": 500, "outputMs": 10000, "wallMs": 50000, "calls": 3, "stop": "complete",
        ]
        if flags.contains("-turnDetailsUntimed") { stats["outputMs"] = nil }
        if flags.contains("-turnDetailsLoop") { stats["stop"] = "loop" }
        var reply: [String: JSONValue] = [
            "id": "measured", "role": "assistant", "content": "The focused tests pass. The reply details belong to the model and effort that actually ran.",
            "turnStats": .object(stats), "interrupted": .bool(flags.contains("-turnDetailsInterrupted")),
        ]
        if flags.contains("-turnDetailsLegacy") { reply["turnStats"] = nil }
        var messages: [JSONValue] = [["id": "prompt", "role": "user", "content": "Check the build and report back."]]
        if flags.contains("-turnDetailsToolOnly") {
            reply["content"] = ""
            reply["toolCalls"] = [["id": "fixture-call", "name": "bash", "input": ["command": "swift test"]]]
            messages += [.object(reply), ["id": "result", "role": "tool", "toolResult": ["toolCallId": "fixture-call", "output": "All tests passed."]]]
        } else { messages.append(.object(reply)) }
        return ["id": "turn-details-fixture", "title": "Reply details", "providerId": "selected-provider", "modelId": "selected-model",
                "effort": "low", "updatedAt": 1793800000000, "messages": .array(messages)]
    }
}
#endif
