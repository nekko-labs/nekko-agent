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
            if ready {
                NewChatView(path: $path)
            }
        }
        .task {
            store.drafts.set(DraftStore.newChat, Draft(providerId: "fixture", modelId: "claude-opus-5-5"))
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
#endif
