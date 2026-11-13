#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The real chat with an in-memory computer whose agent is waiting for a secret
/// (`-uiTestSecretBox`, spec/chat/secrets-in-chat.md): `chat:pending` carries the request
/// and, `-secretResolveAfter N` seconds in, the computer sends `secret_resolved`. No relay,
/// credentials or provider requests, and no value anywhere: the phone never holds one.
struct SecretBoxFixture: View {
    @State private var store = ComputersStore(store: SecretBoxFixtureSecrets(), makeConnection: { _ in SecretBoxFixtureConnection() },
                                              deviceName: { "Secret box test" }, deriveKey: { _, _ in Data(repeating: 2, count: 32) })
    @State private var ready = false
    private static var resolveAfter: Double? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-secretResolveAfter"), args.indices.contains(i + 1) else { return nil }
        return Double(args[i + 1])
    }

    var body: some View {
        NavigationStack {
            if ready { ChatView(sessionId: SecretBoxFixtureConnection.chatId) }
        }
        .environment(store)
        .task {
            store.load()
            try? await store.pair(PairingLink(relayUrl: "wss://fixture.invalid", room: "a1b2c3d4e5f60718",
                                            key: "00112233445566778899aabbccddeeff",
                                            hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="))
            await store.refresh()
            ready = true
            if let after = Self.resolveAfter {
                try? await Task.sleep(for: .seconds(after))
                SecretBoxFixtureConnection.shared?.resolve()
            }
        }
    }
}

private final class SecretBoxFixtureSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

final class SecretBoxFixtureConnection: RemoteConnection, @unchecked Sendable {
    static let chatId = "secret-box-fixture"
    private let lock = NSLock()
    private var status: (@Sendable (RelayStatus) -> Void)?
    private var event: (@Sendable (String, JSONValue) -> Void)?
    private var messages: [JSONValue] = [
        ["id": "m-0", "role": "user", "content": "Can you summarise the open pull requests?"],
        ["id": "m-1", "role": "assistant", "content": "Three are open: two are ready to merge and one waits on a review."],
    ]
    private var ids: [JSONValue] = []
    private var waiting = true
    nonisolated(unsafe) static var shared: SecretBoxFixtureConnection?
    init() { Self.shared = self }

    /// The box was answered on the computer.
    func resolve() {
        lock.withLock { waiting = false }
        let callback = lock.withLock { event }
        callback?("agent:event", ["type": "secret_resolved", "sessionId": .string(Self.chatId), "callId": "secret-call", "provided": true])
    }

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { status = onStatus; event = onEvent }
    }
    func connect() { lock.withLock { status }?(RelayStatus(.online)) }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        switch channel {
        case Channels.settingsGet: return ["defaultProviderId": "fixture", "defaultModelId": "fixture"]
        case Channels.chatPending:
            return lock.withLock { waiting } ? [Self.chatId: ["secret": ["callId": "secret-call", "name": "OPENAI_API_KEY",
                "reason": "To call the API for the weekly report. Create one at platform.openai.com/api-keys.", "requestedAt": 1]]] : [:]
        case Channels.sessionGet:
            return lock.withLock { ["id": .string(Self.chatId), "title": "Release check", "providerId": "fixture", "modelId": "fixture",
                                    "messages": .array(messages), "queue": [], "clientMessageIds": .array(ids)] }
        case Channels.chatSend:
            let prompt = args.first ?? .null
            let reply = lock.withLock { () -> String in
                let n = messages.count
                let text = "Reply \(n / 2 + 1): done, nothing else needs you."
                messages.append(["id": .string("m-\(n)"), "role": "user", "content": .string(prompt.str("text") ?? "")])
                messages.append(["id": .string("m-\(n + 1)"), "role": "assistant", "content": .string(text)])
                ids.append(prompt["clientMessageId"] ?? .null)
                return text
            }
            let callback = lock.withLock { event }
            callback?("agent:event", ["type": "text", "sessionId": .string(Self.chatId), "delta": .string(reply)])
            callback?("agent:event", ["type": "done", "sessionId": .string(Self.chatId)])
            return .null
        default: return .null
        }
    }
}
#endif
