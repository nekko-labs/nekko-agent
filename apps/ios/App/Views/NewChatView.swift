import NekkoKit
import NekkoProtocol
import SwiftUI

/// Start a chat on the computer: model (every enabled provider's, starred
/// first), project folder, tool policy, and the first message.
struct NewChatView: View {
    @Binding var path: [Route]
    /// Show the created chat (pushed on iPhone, the split view's detail on iPad).
    var opened: (String) -> Void = { _ in }
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: (String, String)?
    @State private var folder: String?
    @State private var mode: PcSettings.ChatMode?
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showModels = false

    var body: some View {
        Form {
            Section {
                TextField("What should your computer do?", text: $text, axis: .vertical).lineLimit(3...10)
            }
            Section {
                Button { showModels = true } label: {
                    HStack {
                        Text(model.map { modelName($0) } ?? "Choose a model").foregroundStyle(model == nil ? palette.inkFaint : palette.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.inkFaint)
                    }
                }
            } header: {
                SectionHeader("Model")
            }
            Section {
                Picker("Folder", selection: $folder) {
                    Text("General").tag(String?.none)
                    ForEach(store.workspaces) { w in Text(w.name).tag(Optional(w.id)) }
                }
                .pickerStyle(.navigationLink)
            } header: {
                SectionHeader("Project")
            }
            Section {
                Picker("Tools", selection: $mode) {
                    Text("Computer default").tag(PcSettings.ChatMode?.none)
                    ForEach(PcSettings.ChatMode.allCases, id: \.self) { m in Text(modeName(m)).tag(Optional(m)) }
                }
                .pickerStyle(.navigationLink)
            } footer: {
                Text("How the agent asks before it runs tools on \(store.active?.name ?? "your computer"). Its default is \(modeName(store.pcSettings.effectiveMode)).")
                    .foregroundStyle(palette.inkSoft)
            }
            if let error { Section { Text(error).foregroundStyle(palette.danger) } }
        }
        .navigationTitle("New chat")
        .keyboardDoneButton()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Start", action: start).disabled(busy || model == nil || store.conn != .online)
            }
        }
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (model?.0, model?.1)) { p, m in
                model = (p, m)
                if let id = store.activeId { app.prefs.lastModel[id] = "\(p)::\(m)" }
            }
        }
        .onAppear(perform: pickDefault)
        // The computer's defaults may arrive after this screen opened.
        .onChange(of: store.defaults) { _, _ in pickDefault() }
    }

    private func modelName(_ m: (String, String)) -> String {
        let name = store.models[m.0]?.first { $0.id == m.1 }?.name ?? m.1
        let provider = store.providers.first { $0.id == m.0 }?.label ?? m.0
        return "\(name) · \(provider)"
    }

    /// The last model used for a new chat on this computer, else the computer's default.
    private func pickDefault() {
        guard model == nil else { return }
        if let id = store.activeId, let last = app.prefs.lastModel[id], let r = last.range(of: "::") {
            let p = String(last[..<r.lowerBound])
            if store.providers.contains(where: { $0.id == p && $0.enabled }) {
                model = (p, String(last[r.upperBound...]))
                return
            }
        }
        if let p = store.defaults.defaultProviderId, let m = store.defaults.defaultModelId, m != autoModelId { model = (p, m) }
    }

    private func start() {
        guard let model else { return }
        let (p, m) = model
        busy = true
        error = nil
        Task {
            do {
                let id = try await store.createChat(providerId: p, modelId: m, workspaceId: folder, mode: mode)
                // The chat's own model sends the first message, so a failure shows
                // there and the text comes back in its composer.
                let first = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !first.isEmpty { app.firstMessages[id] = first }
                opened(id)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// Every enabled provider's models on the computer, listed in parallel; starred first.
struct ModelPicker: View {
    let selected: (String?, String?)
    var pick: (String, String) -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if !favorites.isEmpty && query.isEmpty {
                    Section("Starred on your computer") {
                        ForEach(favorites, id: \.self) { f in
                            let pm = split(f)
                            row(pm.0, pm.1, store.models[pm.0]?.first { $0.id == pm.1 }?.name ?? pm.1)
                        }
                    }
                }
                ForEach(store.modelGroups) { g in
                    Section(g.provider.label) {
                        if let e = g.error {
                            Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.warning)
                        } else if let models = g.models {
                            let shown = models.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) }
                            if shown.isEmpty { Text("No models").font(.footnote).foregroundStyle(palette.inkFaint) }
                            ForEach(shown) { m in row(g.provider.id, m.id, m.name, loaded: m.loaded) }
                        } else {
                            ProgressView()
                        }
                    }
                }
            }
            .searchable(text: $query)
            .refreshable { await store.loadAllModels(force: true) }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadAllModels() }
        }
    }

    private var favorites: [String] { store.defaults.favoriteModels.filter { f in store.providers.contains { $0.enabled && f.hasPrefix($0.id + "::") } } }

    private func split(_ f: String) -> (String, String) {
        guard let r = f.range(of: "::") else { return (f, "") }
        return (String(f[..<r.lowerBound]), String(f[r.upperBound...]))
    }

    private func row(_ p: String, _ m: String, _ name: String, loaded: Bool = false) -> some View {
        Button {
            pick(p, m)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(name).foregroundStyle(palette.ink)
                    if name != m { Text(m).font(.caption2).foregroundStyle(palette.inkFaint) }
                }
                Spacer()
                if loaded { Text("Loaded").font(.caption2).foregroundStyle(palette.success) }
                if selected.0 == p && selected.1 == m { Image(systemName: "checkmark").foregroundStyle(palette.accent) }
            }
        }
        .accessibilityAddTraits(selected.0 == p && selected.1 == m ? .isSelected : [])
    }
}
