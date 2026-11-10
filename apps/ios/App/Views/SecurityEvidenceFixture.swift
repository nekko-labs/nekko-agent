#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The real ChatView with an MCP tool waiting for approval in a chat that read a
/// web page (decision 0054), against an in-memory computer (`-uiTestSecurityEvidence`).
/// The card offers "Always allow this tool"; Simple's tool picker shows the YOLO
/// warning. `-securityEvidenceOpen <url>` opens a link once the chat shows (the
/// notification's or the Live Activity's "Always allow"), and `-securityEvidenceCard
/// YES` draws the Lock Screen card for this approval above the chat. No sockets,
/// provider requests, secrets or transcript files are used; this phone has no
/// Change key, so a guarded save is refused, as a cancelled Face ID would be.
struct SecurityEvidenceFixture: View {
    @Environment(AppModel.self) private var app
    @State private var store: ComputersStore
    @State private var connection: SecurityEvidenceConnection
    @State private var ready = false
    @State private var callSummary = "Calls: 0; accepted: 0"

    /// Both options use only protocols available on the evidence baseline.
    /// -securityEvidenceQuestion YES substitutes a question for the approval.
    /// -securityEvidenceControls YES enables synthetic transport controls and call inspection.
    init() {
        let connection = SecurityEvidenceConnection()
        _connection = State(initialValue: connection)
        _store = State(initialValue: ComputersStore(
            store: SecurityEvidenceSecrets(), makeConnection: { _ in connection },
            deviceName: { "Test iPhone" }, deriveKey: { _, _ in Data(repeating: 0, count: 32) }))
    }

    var body: some View {
        NavigationStack {
            if ready { ChatView(sessionId: SecurityEvidenceConnection.chatId) }
        }
        .safeAreaInset(edge: .top) {
            if UserDefaults.standard.bool(forKey: "securityEvidenceCard") {
                LiveCardView(state: Self.card, level: .standard, interactive: false)
                    .padding(14)
                    .background(LiveCardView.background, in: RoundedRectangle(cornerRadius: 22))
                    .padding(.horizontal, 12)
                    // Keep an addressable container without merging or hiding the real metrics.
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("securityEvidence.card")
            }
            if ready && UserDefaults.standard.bool(forKey: "securityEvidenceControls") {
                VStack(spacing: 8) {
                    HStack(spacing: 16) {
                        Button("Offline") { connection.setMode(.offline) }
                            .accessibilityIdentifier("securityEvidence.offline")
                        Button("Fail calls") { connection.setMode(.failure) }
                            .accessibilityIdentifier("securityEvidence.failure")
                        Button("Succeed") { connection.setMode(.success) }
                            .accessibilityIdentifier("securityEvidence.success")
                        Button("Inspect calls") { callSummary = connection.summary }
                            .accessibilityIdentifier("securityEvidence.inspect")
                    }
                    Text("Link: \(store.conn.rawValue)").accessibilityIdentifier("securityEvidence.status")
                    Text(callSummary).accessibilityIdentifier("securityEvidence.calls")
                }
                .font(.caption)
                .buttonStyle(.plain)
                .padding(8)
            }
        }
        .environment(store)
        .task {
            store.load()
            _ = try? await store.pair(PairingLink(relayUrl: "ws://localhost:1440", room: "a1b2c3d4e5f60718",
                                                key: "00112233445566778899aabbccddeeff",
                                                hostKey: "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=", pair: "ABCD2345"))
            ready = true
            if let link = UserDefaults.standard.string(forKey: "securityEvidenceOpen"), let url = URL(string: link) {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                app.handle(url: url)
            }
        }
    }
}

extension SecurityEvidenceFixture {
    /// The Lock Screen card with this chat's MCP approval waiting.
    static let card = LiveCardState(chats: [
        LiveChat(id: SecurityEvidenceConnection.chatId, short: "Release", state: .needsYou, step: "slack: post_message",
                 reply: "", closeWord: "Nice", finishedAt: nil, callId: "post", severity: "high",
                 startedAt: Date().addingTimeInterval(-95), title: "Release notes", alwaysAllow: true),
    ], focusId: SecurityEvidenceConnection.chatId, more: 0, listening: false, heard: "")
}

private final class SecurityEvidenceSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class SecurityEvidenceConnection: RemoteConnection, @unchecked Sendable {
    static let chatId = "security-evidence"
    enum Mode: Equatable { case offline, failure, success }
    private let question = UserDefaults.standard.bool(forKey: "securityEvidenceQuestion")
    private let controls = UserDefaults.standard.bool(forKey: "securityEvidenceControls")
    private let lock = NSLock()
    private var mode: Mode = .offline
    private var onStatus: (@Sendable (RelayStatus) -> Void)?
    private var attempts = 0
    private var accepted = 0

    var summary: String { lock.withLock { "Calls: \(attempts); accepted: \(accepted)" } }

    func setMode(_ mode: Mode) {
        let handler = lock.withLock {
            self.mode = mode
            return onStatus
        }
        handler?(RelayStatus(mode == .offline ? .offline : .online))
    }

    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?,
                     onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { self.onStatus = onStatus }
    }
    // Preserve the original security fixture's silent connection unless controls are requested.
    func connect() { if controls { setMode(lock.withLock { mode }) } }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
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
            if lock.withLock({ accepted > 0 }) { return .object([:]) }
            if question {
                return [Self.chatId: ["question": [
                    "callId": "release-question", "askedAt": 1793800000000,
                    "questions": [["id": "destination", "header": "Destination",
                                   "question": "Where should I post the release summary?", "multiSelect": false,
                                   "options": [["label": "Releases"], ["label": "Engineering"]]]],
                ]]]
            }
            return [Self.chatId: ["approval": [
                "call": ["id": "post", "name": "mcp__slack__post_message",
                         "input": ["channel": "#releases", "text": "Release 2.4: faster sync, new themes."]],
                "reason": "This chat read content from outside this computer, and an MCP tool could send data out.",
                "severity": "high",
            ]]]
        case Channels.chatAnswer, Channels.toolApprove:
            return try lock.withLock {
                guard controls else { return .null }
                attempts += 1
                guard mode == .success else { throw RelayError("Synthetic response call failed.") }
                let expectedChannel = question ? Channels.chatAnswer : Channels.toolApprove
                let expectedCall = question ? "release-question" : "post"
                let expectedPayload: JSONValue = question
                    ? [["questionId": "destination", "labels": ["Releases"]]] : .bool(true)
                guard channel == expectedChannel,
                      args == [.string(Self.chatId), .string(expectedCall), expectedPayload], accepted == 0 else {
                    throw RelayError("Unexpected synthetic response payload or duplicate delivery.")
                }
                accepted += 1
                return .null
            }
        default:
            return .null
        }
    }
}
#endif
