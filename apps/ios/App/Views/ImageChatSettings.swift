import NekkoKit
import NekkoProtocol
import SwiftUI

/// Image-only catalog and sampling controls. No install, remove, file or cloud actions.
struct ImageChatSettings: View {
    @Binding var params: ImageChatParams
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var error: String?
    @State private var loading = false
    var save: ((ImageChatParams) async throws -> Void)? = nil
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Local image model") {
                    if loading { ProgressView("Reading image models…") }
                    if let error { Text(error).foregroundStyle(palette.danger).accessibilityIdentifier("imageChat.error") }
                    Picker("Image model", selection: $params.modelId) {
                        Text("Choose a model").tag(String?.none)
                        ForEach(store.imageModels) { model in
                            Text(model.name).tag(Optional(model.id))
                        }
                    }
                    .accessibilityIdentifier("imageChat.model")
                    if !loading && store.imageModels.isEmpty {
                        Text("No local image models available. Finish model and runtime setup on your computer, then refresh here.")
                    }
                    Button("Refresh models") { Task { await load() } }
                    Text("Only image-capable local models on the selected computer are listed. Vision chat models are not image generators.")
                }
                Section("Image settings") {
                    Picker("Size", selection: size) {
                        ForEach(["512×512", "768×768", "1024×1024", "1024×768", "768×1024", "1344×768", "768×1344"], id: \.self) { Text($0).tag($0) }
                    }.accessibilityIdentifier("imageChat.size")
                    Stepper("Steps: \(params.steps)", value: $params.steps, in: 1...100)
                    Stepper("CFG: \(params.cfgScale, specifier: "%.1f")", value: $params.cfgScale, in: 0...30, step: 1)
                    Text("Existing Change proofs require whole-number CFG values.")
                    if params.cfgScale != params.cfgScale.rounded() {
                        Button("Use CFG 4 for phone generation") { params.cfgScale = 4 }
                    }
                    TextField("Seed (−1 is random)", value: $params.seed, format: .number)
                        .keyboardType(.numbersAndPunctuation)
                        .accessibilityIdentifier("imageChat.seed")
                    Button("Use random seed") { params.seed = -1 }
                    Text("Text prompts only. Attachments and skills are not supported. Generation requires an online computer and existing Change authorization; prompts are never queued as text.")
                }
            }
            .navigationTitle("Image settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Done") {
                        guard let save else { dismiss(); return }
                        saving = true
                        Task {
                            do { try await save(params); dismiss() }
                            catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    }
                    .disabled(saving || (save != nil && (!params.valid || !store.imageModels.contains { $0.id == params.modelId })))
                }
            }
            .task(id: store.activeId) { await load() }
        }
    }

    private var size: Binding<String> {
        Binding(get: { "\(params.width)×\(params.height)" }, set: { value in
            let parts = value.split(separator: "×").compactMap { Int($0) }
            guard parts.count == 2 else { return }
            params.width = parts[0]; params.height = parts[1]
        })
    }

    private func load() async {
        loading = true
        error = nil
        do { try await store.loadImageModels() }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

/// A separate draft means dismissing without saving cannot change a live chat.
struct ImageChatSettingsSheet: View {
    let chat: ChatModel
    @State private var params: ImageChatParams

    init(chat: ChatModel) {
        self.chat = chat
        _params = State(initialValue: chat.session?.imageParams ?? ImageChatParams())
    }

    var body: some View {
        ImageChatSettings(params: $params, save: { try await chat.setImageParams($0) })
    }
}
