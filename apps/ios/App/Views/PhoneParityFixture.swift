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

/// The chat's new Run settings rows and its Tools list, with fixed values, for captures.
struct RunSettingsFixture: View {
    @Environment(\.palette) private var palette
    @State private var options: [String: JSONValue] = ["memory": "project", "guidance": "rules", "privacy": ["mode": "redact"]]
    @State private var off: [String] = ["web_fetch"]
    @State private var showTools = ProcessInfo.processInfo.arguments.contains("-uiTestRunSettingsTools")
    var body: some View {
        NavigationStack {
            List {
                Section("Run settings") {
                    ForEach(RunOption.all.filter { ["memory", "guidance", "privacy"].contains($0.key) }) { option in
                        RunOptionRow(option: option, value: options[option.key]) { options[option.key] = $0 }
                    }
                    Button { showTools = true } label: {
                        HStack { Text("Tools"); Spacer(); Text("\(off.count) off").foregroundStyle(palette.inkSoft) }
                    }
                    .accessibilityIdentifier("run.disabledTools")
                }
            }
            .navigationTitle("Run settings")
            .sheet(isPresented: $showTools) {
                        ToolsList(load: { [ToolInfo(name: "bash", description: "Run a shell command in the chat's folder."),
                                           ToolInfo(name: "read_file", description: "Read a file in the chat's folders."),
                                           ToolInfo(name: "web_fetch", description: "Fetch a web page and read it as text."),
                                           ToolInfo(name: "spawn_agent", description: "Start a sub-agent for part of the work.")] },
                                  disabled: { off },
                                  set: { name, on in off = off.filter { $0 != name } + (on ? [] : [name]) })
            }
        }
    }
}
#endif
