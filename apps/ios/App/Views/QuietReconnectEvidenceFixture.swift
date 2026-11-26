#if DEBUG
import Foundation
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Real Chat and New Chat surfaces against one memory-only reconnecting computer (#2473).
/// Run only in the disposable evidence simulator. The fixture uses no credentials, sockets,
/// push registration or production stores.
struct QuietReconnectEvidenceFixture: View {
    private static let chatId = "quiet-reconnect-evidence"
    private static let savedAt: Int64 = 1_793_800_000_000
    @State private var store = ComputersStore(
        store: QuietReconnectSecrets(), makeConnection: { _ in QuietReconnectConnection() },
        deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) },
        now: { Self.savedAt }, offlineFiles: nil)
    @State private var cache = QuietReconnectCache()
    @State private var path: [Route] = []
    @State private var ready = false

    private var showsNewChat: Bool {
        ProcessInfo.processInfo.arguments.contains("-quietReconnectNewChat")
    }

    var body: some View {
        NavigationStack {
            if ready {
                if showsNewChat {
                    NewChatView(path: $path)
                } else {
                    ChatView(sessionId: Self.chatId)
                }
            }
        }
        .environment(store)
        .task {
            guard !ready else { return }
            store.load()
            _ = try? await store.pair(PairingLink(
                relayUrl: "ws://localhost:1440", room: "a1b2c3d4e5f60718",
                key: "00112233445566778899aabbccddeeff",
                hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=",
                pair: "ABCD2345"))
            if let id = store.activeId { store.rename(id, to: "Studio Mac") }
            store.transcriptCache = cache
            let session: JSONValue = [
                "id": .string(Self.chatId), "title": "Release plan", "modelId": "fixture-model",
                "updatedAt": .int(Self.savedAt),
                "messages": [
                    ["id": "prompt", "role": "user", "content": "What should we check before the release?"],
                    ["id": "reply", "role": "assistant", "content": "Check the tests and review the release notes."],
                ],
            ]
            if let saved = Session.from(session) { store.transcripts.save(saved) }
            store.drafts.set(DraftStore.newChat, Draft(text: "Review the release notes"))
            ready = true
        }
    }
}

private final class QuietReconnectSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class QuietReconnectCache: TranscriptCache, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: [String: Data]] = [:]
    func load(_ computerId: String, _ name: String) -> Data? { lock.withLock { values[computerId]?[name] } }
    func save(_ computerId: String, _ name: String, _ data: Data) {
        lock.withLock { values[computerId, default: [:]][name] = data }
    }
    func removeFile(_ computerId: String, _ name: String) { lock.withLock { values[computerId]?[name] = nil } }
    func removeComputer(_ computerId: String) { lock.withLock { values[computerId] = nil } }
    func removeAll() { lock.withLock { values = [:] } }
}

/// Remains reconnecting, with no timers, sockets, push registration or remote calls.
private final class QuietReconnectConnection: RemoteConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var onStatus: (@Sendable (RelayStatus) -> Void)?

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { self.onStatus = onStatus }
    }
    func connect() { lock.withLock { onStatus }?(RelayStatus(.connecting)) }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        throw RelayError("Evidence computer is reconnecting")
    }
}
#endif
