#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The real chat with an in-memory computer; no sockets, credentials or disk writes.
struct ChatRefreshFixture: View {
    @State private var store = ComputersStore(
        store: RefreshFixtureSecrets(), makeConnection: { _ in RefreshFixtureConnection() },
        deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) })
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ready { ChatView(sessionId: "refresh-fixture") }
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

private final class RefreshFixtureSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class RefreshFixtureConnection: RemoteConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
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
        let read = lock.withLock { reads += 1; return reads }
        if read > 1 { try await Task.sleep(for: .seconds(3)) }
        // The transcript arrives after the empty chat is on screen, as from a computer far away.
        else if ProcessInfo.processInfo.arguments.contains("-refreshSlowFirstRead") { try await Task.sleep(for: .seconds(1)) }
        let count = ProcessInfo.processInfo.arguments.contains("-refreshLongChat") ? 30 : 2
        let messages: [JSONValue] = (1...count).map { i in
            ["id": .string("m-\(i)"), "role": .string(i % 2 == 0 ? "assistant" : "user"),
             "content": .string(i == count ? "You are at the latest message." : "Message \(i): let’s check the refresh at the end of this chat.")]
        }
        return ["id": "refresh-fixture", "title": "Refresh from the latest", "modelId": "claude-opus-5-5",
                "updatedAt": 1793800000000, "messages": .array(messages)]
    }
}
#endif
