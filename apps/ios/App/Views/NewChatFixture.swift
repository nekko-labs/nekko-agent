#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// Real New chat, with an offline draft and no pairing or network side effects.
struct NewChatFixture: View {
    @Environment(ComputersStore.self) private var store
    @State private var path: [Route] = []
    @State private var ready = false

    var body: some View {
        NavigationStack {
            if ProcessInfo.processInfo.arguments.contains("-uiTestAutomatic") {
                AutomaticMachineFixture()
            } else if ready {
                NewChatView(path: $path)
            }
        }
        .task {
            let starred = ProcessInfo.processInfo.arguments.contains("-uiTestStarredDraft")
            store.drafts.set(DraftStore.newChat, Draft(text: starred ? "Review both folders" : "", providerId: "fixture", modelId: "claude-opus-5-5",
                                                     workspaceId: starred ? "app" : nil, useDefaultFolders: starred ? true : nil,
                                                     supportingWorkspaceIds: starred ? ["docs"] : []))
            ready = true
        }
    }
}

/// The computer's model picker over one cloud and one local provider (`-uiTestModelTabs`),
/// seeded as if the computer had sent them, with no pairing or network.
struct ModelTabsFixture: View {
    @Environment(ComputersStore.self) private var store
    @State private var ready = false

    var body: some View {
        // A ZStack, not a Group: an empty Group never appears, so its task would never run.
        ZStack {
            Color.clear
            if ready { ModelPicker(selected: ("anthropic", "claude-opus-5-5")) { _, _ in } }
        }
        .task {
            store.seedModelsForUITest(providers: [
                ["id": "anthropic", "kind": "anthropic", "label": "Claude API", "enabled": true],
                ["id": "ollama", "kind": "ollama", "label": "Ollama", "enabled": true],
            ], models: [
                "anthropic": [["id": "claude-opus-5-5", "name": "Claude Opus 5.5"], ["id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5"]],
                "ollama": [["id": "qwen3:8b", "name": "Qwen3 8B", "loaded": true]],
            ])
            ready = true
        }
    }
}

/// Two scripted fleet links; nothing reaches a relay, a model server or the Keychain.
@MainActor
private struct AutomaticMachineFixture: View {
    @Environment(AppModel.self) private var app
    @State private var store = ComputersStore(
        store: AutomaticMachineSecrets(),
        makeConnection: { AutomaticMachineConnection(config: $0) },
        deviceName: { "Test iPhone" },
        deriveKey: { _, _ in Data(repeating: 7, count: 32) },
        stayConnected: true)
    @State private var path: [Route] = []
    @State private var ready = false

    var body: some View {
        ZStack {
            Color.clear
            if ready { NewChatView(path: $path).environment(store) }
        }
        .task {
            guard !ready else { return }
            store.load()
            // Two computers, two host keys: a known host key is the same computer re-paired.
            let hostKeys = ["bbbb": "BJ7go4GGB9flqEQfjn77eO+WT5J+xi8WJkMUlZycp+JNohdWg8JmKM5w1b22gUGNVRucsADtge0BdgHP9q8HUaE=",
                            "aaaa": String(repeating: "A", count: 87) + "="]
            for (room, name) in [("bbbb", "Studio Mac"), ("aaaa", "MacBook")] {
                let hostKey = hostKeys[room]!
                let link = PairingLink(relayUrl: "wss://fixture.invalid", room: room,
                                       key: "00112233445566778899aabbccddeeff", hostKey: hostKey, pair: nil)
                if let id = try? await store.pair(link) { store.rename(id, to: name) }
                for _ in 0..<20 { await Task.yield() }
                await store.refresh()
            }
            app.prefs.chatsFilter = nil
            if let id = store.activeId { app.prefs.lastFolder[id] = nil }
            store.drafts.set(DraftStore.newChat, Draft(text: "Explain this local model", providerId: "mac-ollama", modelId: "qwen3:8b"))
            ready = true
        }
    }
}

private final class AutomaticMachineSecrets: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String?) { lock.withLock { values[key] = value } }
}

private final class AutomaticMachineConnection: RemoteConnection, @unchecked Sendable {
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
        let busy = config.room == "aaaa" || ProcessInfo.processInfo.arguments.contains("-uiTestAllBusy")
        let provider = config.room == "aaaa" ? "mac-ollama" : "studio-ollama"
        switch channel {
        case "activity:state":
            if ProcessInfo.processInfo.arguments.contains("-uiTestSlowAuto") { try await Task.sleep(for: .seconds(3)) }
            return ["userActive": .bool(busy), "chatActive": false, "headless": false, "strain": []]
        case Channels.providersList:
            return [["id": .string(provider), "kind": "ollama", "label": "Ollama", "enabled": true]]
        case Channels.modelsList:
            return [["id": "qwen3:8b", "name": "Qwen3 8B", "loaded": true]]
        case Channels.workspaceList:
            return [["id": "project", "name": "Project", "path": "/fixture/project"]]
        default: return .null
        }
    }
}

#endif
