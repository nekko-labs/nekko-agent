#if DEBUG
import NekkoKit
import NekkoProtocol
import SwiftUI

/// The production views over deterministic in-memory data; never pairs or calls a host.
struct PhoneParityFixture: View {
    @Environment(Prefs.self) private var prefs
    @Environment(ComputersStore.self) private var store
    @State private var path: [Route] = []
    @State private var step = 0
    var body: some View {
        NavigationStack {
            ChatsView(path: $path)
                .safeAreaInset(edge: .bottom) {
                    HStack {
                        Button("Advance agent") { step = (step + 1) % 4; store.seedParityFixture(step: step) }
                        NavigationLink("Folders") { FoldersView() }
                    }.buttonStyle(.bordered).padding(8)
                }
        }
        .task {
            prefs.chatListView = .standard
            store.seedParityFixture()
            if ProcessInfo.processInfo.arguments.contains("-uiTestAnimateGroups") {
                for next in 1...3 {
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled else { return }
                    step = next
                    store.seedParityFixture(step: next)
                }
            }
        }
    }
}
struct PhoneComposerFixture: View {
    @Environment(PhoneChats.self) private var phone
    var body: some View {
        NavigationStack { PhoneChatView(chatId: "phone-parity") }
            .task { phone.seedComposerFixture() }
    }
}
/// Actual voice UI with scripted, silent audio. No microphone, TTS or model is called.
struct VoiceConversationFixture: View {
    @State private var voice = VoiceConversation()
    var body: some View {
        VoiceConversationView(makeTarget: { throw CancellationError() }, state: voice)
            .task {
                voice.start(capture: {
                    try await Task.sleep(for: .seconds(2))
                    return "What is ready?"
                }, respond: { _ in
                    try await Task.sleep(for: .seconds(2))
                    return "The iPhone changes are ready for review."
                }, speak: { _ in try await Task.sleep(for: .seconds(3)) }, stopAudio: {})
            }
    }
}

/// The agent details' Model Server section with fixed values, for captures (`-uiTestModelServer`, `-uiTestModelServerLocked`).
struct ModelServerFixture: View {
    @State private var server = ModelServerSettings.from(["maxLoaded": 2, "idleTtlSeconds": 900, "jitLoad": true,
        "clientModelSettings": .bool(!ProcessInfo.processInfo.arguments.contains("-uiTestModelServerLocked"))])!
    var body: some View {
        NavigationStack {
            List {
                Section {
                    ModelServerControls(server: server, loadable: ModelInfo.list([["id": "qwen3-coder-30b", "name": "Qwen3 Coder 30B"], ["id": "gemma-3-27b", "name": "Gemma 3 27B"]]),
                                        holdsModels: true, load: { _ in }, unloadAll: {}, set: { _ in }) { _ in }
                } header: {
                    Text("Model Server")
                } footer: {
                    Text(server.devicesChoose ? "Each change asks for Face ID." : "gomi’s Model Server keeps its own model settings. Change them there, or turn on Connected devices choose model settings.")
                }
            }
            .navigationTitle("Agent on gomi")
        }
    }
}
#endif
