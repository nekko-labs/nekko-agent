#if DEBUG
import Foundation
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Real banner, saved transcript and composer against a memory-only computer (#2473).
/// Run only in the disposable evidence simulator. Lifecycle work is disabled;
/// the fixture computer, transcript cache and outbox never use real credentials or transport.
struct QuietReconnectEvidenceFixture: View {
    private static let chatId = "quiet-reconnect-evidence"
    private static let savedAt: Int64 = 1793800000000
    @State private var store = ComputersStore(
        store: QuietReconnectSecrets(), makeConnection: { _ in QuietReconnectConnection() },
        deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) },
        now: { savedAt }, offlineFiles: nil)
    @State private var cache = QuietReconnectCache()
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ready {
                ChatView(sessionId: Self.chatId)
                    .safeAreaInset(edge: .top) {
                        ConnectionBanner()
                            .padding(.horizontal, 16)
                            .accessibilityIdentifier("quietReconnect.banner")
                    }
            }
        }
        .environment(store)
        .task {
            guard !ready else { return }
            store.load()
            // A fixed synthetic pairing, handled entirely by the no-op connection below.
            _ = try? await store.pair(PairingLink(
                relayUrl: "ws://localhost:1440", room: "a1b2c3d4e5f60718",
                key: "00112233445566778899aabbccddeeff",
                hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=", pair: "ABCD2345"))
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
            let args = ProcessInfo.processInfo.arguments
            let index = args.firstIndex(of: "-quietReconnectCount")
            let requested = index.flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil } ?? 0
            for i in 0..<min(3, max(0, requested)) {
                store.outbox.add(chatId: Self.chatId, text: "Review item \(i + 1)", id: "quiet-prompt-\(i)")
            }
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

@MainActor
private final class QuietReconnectCache: TranscriptCache {
    private var values: [String: [String: Data]] = [:]
    func load(_ computerId: String, _ name: String) -> Data? { values[computerId]?[name] }
    func save(_ computerId: String, _ name: String, _ data: Data) {
        values[computerId, default: [:]][name] = data
    }
    func removeFile(_ computerId: String, _ name: String) { values[computerId]?[name] = nil }
    func removeComputer(_ computerId: String) { values[computerId] = nil }
    func removeAll() { values = [:] }
}

/// Remains connecting, with no timers, sockets, push registration or remote calls.
private final class QuietReconnectConnection: RemoteConnection, @unchecked Sendable {
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {}
    func connect() {}
    func close() {}
    func nudge() {}
    func reconnect() {}
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        throw RelayError("Evidence computer is reconnecting")
    }
}
#endif
