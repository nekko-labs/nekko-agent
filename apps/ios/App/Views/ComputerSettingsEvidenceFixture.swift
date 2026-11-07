#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// A real computer list and detail page backed exclusively by an in-memory relay.
@MainActor
struct ComputerSettingsEvidenceFixture: View {
    @State private var store = ComputersStore(
        store: ComputerEvidenceSecrets(),
        makeConnection: { ComputerEvidenceConnection(config: $0) },
        deviceName: { "Test iPhone" },
        deriveKey: { _, _ in Data(repeating: 7, count: 32) },
        stayConnected: true)
    @State private var ready = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.clear
                if ready { ComputersView() }
            }
            .navigationDestination(for: Route.self) { route in
                if case .computer(let id) = route { ComputerDetailView(computerId: id) }
            }
        }
        .environment(store)
        .task {
            guard !ready else { return }
            store.load()
            let key = "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE="
            let link = PairingLink(relayUrl: "wss://fixture.invalid", room: "bbbb",
                                   key: "00112233445566778899aabbccddeeff", hostKey: key, pair: nil)
            if let id = try? await store.pair(link) { store.rename(id, to: "Studio Mac") }
            for _ in 0..<20 { await Task.yield() }
            await store.refresh()
            ready = true
        }
    }
}

private final class ComputerEvidenceSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class ComputerEvidenceConnection: RemoteConnection, @unchecked Sendable {
    let config: RelayConfig
    private let lock = NSLock()
    private var onStatus: (@Sendable (RelayStatus) -> Void)?
    private var onWelcome: (@Sendable (WelcomedDevice) -> Void)?
    init(config: RelayConfig) { self.config = config }
    func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)?, onEvent: (@Sendable (String, JSONValue) -> Void)?, onWelcome: (@Sendable (WelcomedDevice) -> Void)?) {
        lock.withLock { self.onStatus = onStatus; self.onWelcome = onWelcome }
    }
    func connect() {
        let (status, welcome) = lock.withLock { (onStatus, onWelcome) }
        welcome?(WelcomedDevice(id: config.deviceId, name: config.deviceName, platform: "ios", protocolVersion: 1))
        status?(RelayStatus(.online))
    }
    func close() {}
    func nudge() {}
    func reconnect() { connect() }
    func registerPush(token: String) async throws {}
    func registerCard(token: String?, startToken: String?, level: LiveLevel, computerId: String, computerName: String) async throws {}
    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        switch channel {
        case Channels.providersList:
            return [["id": "anthropic", "kind": "anthropic", "label": "Claude API", "enabled": true],
                    ["id": "ollama", "kind": "ollama", "label": "Ollama", "enabled": true]]
        case Channels.modelsList:
            if args.first?.string == "anthropic" {
                return [["id": "claude-opus", "name": "Claude Opus", "providerId": "anthropic"]]
            }
            return [["id": "qwen3:8b", "name": "Qwen3 8B", "providerId": "ollama", "loaded": true]]
        case "service:status":
            let enabled = ProcessInfo.processInfo.arguments.contains("-uiTestServiceEnabled")
            let capability: JSONValue = ["supported": true]
            return ["protocolVersion": 1, "agentRunning": true, "manageServiceFromPhone": .bool(enabled),
                    "capabilities": ["restart": capability, "updateState": capability, "updateCheck": capability,
                                     "updateDownload": capability, "updateInstall": capability]]
        case "service:updateState":
            return ["state": "idle", "currentVersion": "1.0.0", "notesUrl": "https://example.invalid", "edition": "desktop"]
        default: return .null
        }
    }
}
#endif
