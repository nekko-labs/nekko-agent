#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The real ChatView with an MCP tool waiting for approval in a chat that read a
/// web page (decision 0054), against an in-memory computer (`-uiTestSecurityEvidence`).
/// The card offers "Always allow this tool"; Simple's tool picker shows the YOLO
/// warning. No sockets, provider requests, secrets or transcript files are used.
struct SecurityEvidenceFixture: View {
    @State private var store = ComputersStore(
        store: SecurityEvidenceSecrets(), makeConnection: { _ in SecurityEvidenceConnection() },
        deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) })
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ready { ChatView(sessionId: SecurityEvidenceConnection.chatId) }
        }
        .environment(store)
        .task {
            store.load()
            _ = try? await store.pair(PairingLink(relayUrl: "ws://localhost:1440", room: "a1b2c3d4e5f60718",
                                                key: "00112233445566778899aabbccddeeff",
                                                hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=", pair: "ABCD2345"))
            ready = true
        }
    }
}

private final class SecurityEvidenceSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class SecurityEvidenceConnection: RemoteConnection, @unchecked Sendable {
    static let chatId = "security-evidence"

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {}
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        switch channel {
        case Channels.sessionGet:
            let messages: [JSONValue] = [
                ["id": "prompt", "role": "user", "content": "Read the release notes page and post a summary to #releases."],
                ["id": "read", "role": "assistant", "content": "",
                 "toolCalls": [["id": "fetch", "name": "fetch_url", "input": ["url": "https://example.com/releases"]]]],
                ["id": "fetched", "role": "tool", "toolResult": ["toolCallId": "fetch", "output": "Release 2.4: faster sync, new themes."]],
            ]
            return ["id": .string(Self.chatId), "title": "Release notes", "providerId": "anthropic", "modelId": "claude-opus-5-5",
                    "mode": "guardrails", "updatedAt": 1793800000000, "messages": .array(messages), "activeRun": ["startedAt": 1793800000000]]
        case Channels.chatPending:
            return [Self.chatId: ["approval": [
                "call": ["id": "post", "name": "mcp__slack__post_message",
                         "input": ["channel": "#releases", "text": "Release 2.4: faster sync, new themes."]],
                "reason": "This chat read content from outside this computer, and an MCP tool could send data out.",
                "severity": "high",
            ]]]
        default:
            return .null
        }
    }
}
#endif
