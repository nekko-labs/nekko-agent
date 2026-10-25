import NekkoKit
import NekkoProtocol
import SwiftUI

/// Start a chat on the computer: model (every enabled provider's, starred
/// first), effort, the computer a local model runs on, project folder, tool
/// policy, and the first message.
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
    /// nil follows the computer's own effort setting.
    @State private var effort: Effort?
    /// The computer was picked here: keep offering the choice while its models load.
    @State private var pickedComputer = false
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showModels = false
    @State private var restored = false
    /// Why the computer turned down a chat started offline (it came back here).
    @State private var refusal: String?
    @Environment(CloudSync.self) private var cloud
    @State private var cloudBusy = false
    @State private var cloudError: String?
    @Environment(\.dismiss) private var dismiss

    private var offline: Bool { store.conn != .online }

    var body: some View {
        Form {
            if offline {
                Section {
                    Label("\(store.active?.name ?? "Your computer") is \(store.conn == .offline ? "offline" : "reconnecting"). Start now and the chat begins when it’s back; it waits on this iPhone until then.",
                          systemImage: "tray.and.arrow.up")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                        .accessibilityIdentifier("newChat.offlineNote")
                }
            }
            if let refusal {
                Section { Label(refusal, systemImage: "exclamationmark.bubble").font(.footnote).foregroundStyle(palette.danger) }
            }
            Section {
                TextField("What should your computer do?", text: $text, axis: .vertical).lineLimit(3...10)
                    .accessibilityIdentifier("newChat.prompt")
            }
            Section {
                Button { showModels = true } label: {
                    HStack {
                        Text(model.map { modelName($0) } ?? "Choose a model").foregroundStyle(model == nil ? palette.inkFaint : palette.ink)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(palette.inkFaint)
                    }
                }
                if let model {
                    Picker(selection: $effort) {
                        Text("Computer default").tag(Effort?.none)
                        ForEach(Effort.levels(for: model.1), id: \.self) { e in Text(effortName(e)).tag(Optional(e)) }
                    } label: { Text("Effort").foregroundStyle(palette.ink) }
                    .pickerStyle(.navigationLink)
                    .foregroundStyle(palette.ink, palette.inkSoft)
                    .accessibilityIdentifier("newChat.effort")
                }
            } header: {
                SectionHeader("Model")
            } footer: {
                if model != nil { Text("How hard the model works on each reply. Higher takes longer.").foregroundStyle(palette.inkSoft) }
            }
            if isLocal || pickedComputer {
                Section {
                    Picker(selection: Binding(get: { store.activeId }, set: { if let id = $0 { switchComputer(id) } })) {
                        ForEach(store.computers) { c in Text(c.name).tag(Optional(c.id)) }
                    } label: { Text("Run on").foregroundStyle(palette.ink) }
                    .pickerStyle(.navigationLink)
                    .foregroundStyle(palette.ink, palette.inkSoft)
                    .accessibilityIdentifier("newChat.computer")
                } header: {
                    SectionHeader("Computer")
                } footer: {
                    Text("A local model runs on the computer’s own hardware. Choosing another computer shows its models and folders.")
                        .foregroundStyle(palette.inkSoft)
                }
            }
            if cloud.account?.canSync == true {
                // A chat can run on a Nekko Cloud machine instead of a paired computer (decision 0017).
                Section {
                    if let m = cloud.machines.first, let id = cloud.computerId(for: m), store.computers.contains(where: { $0.id == id }) {
                        Button {
                            switchComputer(id)
                        } label: {
                            HStack {
                                Label(m.name, systemImage: "cloud")
                                Spacer()
                                if store.activeId == id { Image(systemName: "checkmark").foregroundStyle(palette.accent) }
                            }
                        }
                        .accessibilityIdentifier("newChat.cloud")
                    } else {
                        Button { Task { await makeCloudMachine() } } label: {
                            if cloudBusy { ProgressView() } else { Label("Run on a new Nekko Cloud machine", systemImage: "cloud") }
                        }
                        .disabled(cloudBusy)
                        .accessibilityIdentifier("newChat.cloud")
                    }
                    if let cloudError { Text(cloudError).font(.footnote).foregroundStyle(palette.danger) }
                } header: {
                    SectionHeader("Nekko Cloud")
                } footer: {
                    Text("A sandboxed machine in the cloud, with no computer needed. It sees only what you put in its scope.").foregroundStyle(palette.inkSoft)
                }
            }
            Section {
                Picker(selection: $folder) {
                    Text("No folder").tag(String?.none)
                    ForEach(store.workspaces) { w in
                        VStack(alignment: .leading) {
                            Text(w.name)
                            if let path = w.path { Text(path).font(.caption).foregroundStyle(palette.inkSoft) }
                        }.tag(Optional(w.id))
                    }
                } label: { Text("Folder").foregroundStyle(palette.ink) }
                .pickerStyle(.navigationLink)
                // The selected value is drawn in the secondary style: inkSoft
                // (about 7:1) rather than the system grey, which sat just under 4.5:1.
                .foregroundStyle(palette.ink, palette.inkSoft)
            } header: {
                SectionHeader("Project")
            }
            Section {
                Picker(selection: $mode) {
                    Text("Computer default").tag(PcSettings.ChatMode?.none)
                    ForEach(PcSettings.ChatMode.allCases, id: \.self) { m in Text(modeName(m)).tag(Optional(m)) }
                } label: { Text("Tools").foregroundStyle(palette.ink) }
                .pickerStyle(.navigationLink)
                // The selected value is drawn in the secondary style: inkSoft
                // (about 7:1) rather than the system grey, which sat just under 4.5:1.
                .foregroundStyle(palette.ink, palette.inkSoft)
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
                Button(offline ? "Start when online" : "Start", action: start)
                    .disabled(busy || model == nil || (offline && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    .accessibilityIdentifier("newChat.start")
            }
        }
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (model?.0, model?.1)) { p, m in
                model = (p, m)
                if let e = effort, !Effort.levels(for: m).contains(e) { effort = nil }
                if let id = store.activeId { app.prefs.lastModel[id] = "\(p)::\(m)" }
            }
        }
        .onAppear(perform: restoreDraft)
        .onAppear(perform: pickDefault)
        .onAppear(perform: takeShared)
        // Kept on the phone like a chat's composer: text, model, folder and tool policy.
        .onChange(of: text) { _, _ in saveDraft() }
        .onChange(of: model?.0) { _, _ in saveDraft() }
        .onChange(of: model?.1) { _, _ in saveDraft() }
        .onChange(of: folder) { _, _ in saveDraft() }
        .onChange(of: mode) { _, _ in saveDraft() }
        .onChange(of: effort) { _, _ in saveDraft() }
        // A chat started offline that the computer turned down comes back here.
        .onChange(of: store.drafts.drafts[DraftStore.newChat]) { _, d in adopt(d) }
        .onChange(of: app.sharedText) { _, _ in takeShared() }
        // The computer's defaults may arrive after this screen opened.
        .onChange(of: store.defaults) { _, _ in pickDefault() }
    }

    /// Text shared from another app becomes the first message, still editable.
    private func takeShared() {
        guard let shared = app.sharedText else { return }
        text = shared
        app.sharedText = nil
    }

    private var isLocal: Bool {
        guard let p = model?.0 else { return false }
        return store.providers.first { $0.id == p }?.isLocal == true
    }

    private func effortName(_ e: Effort) -> LocalizedStringKey {
        switch e {
        case .low: return "Low"
        case .medium: return "Medium"
        case .normal: return "Normal"
        case .high: return "High"
        case .xhigh: return "Extra high"
        case .max: return "Max"
        }
    }

    /// Start the chat on another paired computer: its own models and folders,
    /// so those are chosen again there; the words carry over.
    /// Make a Nekko Cloud machine, pair it and point this chat at it.
    private func makeCloudMachine() async {
        cloudBusy = true
        cloudError = nil
        defer { cloudBusy = false }
        do {
            let made = try await cloud.createMachine(name: "Nekko Cloud", region: "nrt", scope: CloudSync.MachineScope())
            let id = await store.pair(made.link)
            store.rename(id, to: made.machine.name)
            cloud.link(made.machine, computer: id)
            switchComputer(id)
        } catch { cloudError = error.localizedDescription }
    }

    private func switchComputer(_ id: String) {
        guard id != store.activeId else { return }
        pickedComputer = true
        let words = text
        store.connect(id)
        model = nil
        effort = nil
        folder = nil
        refusal = nil
        text = words
        store.drafts.set(DraftStore.newChat, current)
        pickDefault()
    }

    private func modelName(_ m: (String, String)) -> String {
        let name = store.models[m.0]?.first { $0.id == m.1 }?.name ?? m.1
        let provider = store.providers.first { $0.id == m.0 }?.label ?? m.0
        return "\(name) · \(provider)"
    }

    /// The last model used for a new chat on this computer, else the computer's default.
    /// Offline (the providers aren't known yet) the last one is taken as it is.
    private func pickDefault() {
        guard model == nil else { return }
        if let id = store.activeId, let last = app.prefs.lastModel[id], let r = last.range(of: "::") {
            let p = String(last[..<r.lowerBound])
            if store.providers.isEmpty || store.providers.contains(where: { $0.id == p && $0.enabled }) {
                model = (p, String(last[r.upperBound...]))
                return
            }
        }
        if let p = store.defaults.defaultProviderId, let m = store.defaults.defaultModelId, m != autoModelId { model = (p, m) }
    }

    private var current: Draft {
        Draft(text: text, providerId: model?.0, modelId: model?.1, workspaceId: folder, mode: mode?.rawValue, effort: effort?.rawValue, refusal: refusal)
    }

    private func restoreDraft() {
        guard !restored else { return }
        restored = true
        apply(store.drafts.draft(DraftStore.newChat))
    }

    private func apply(_ d: Draft) {
        if !d.text.isEmpty { text = d.text }
        if let p = d.providerId, let m = d.modelId { model = (p, m) }
        if d.workspaceId != nil { folder = d.workspaceId }
        if let m = d.mode.flatMap(PcSettings.ChatMode.init(rawValue:)) { mode = m }
        if let e = d.effort.flatMap(Effort.init(rawValue:)) { effort = e }
        refusal = d.refusal
    }

    private func saveDraft() {
        guard restored else { return }
        store.drafts.set(DraftStore.newChat, current)
    }

    private func adopt(_ stored: Draft?) {
        guard let d = stored, d != current, !d.isEmpty else { return }
        apply(d)
    }

    private func start() {
        guard let model else { return }
        let (p, m) = model
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if offline {
            startLater(p, m, first)
            return
        }
        busy = true
        error = nil
        Task {
            do {
                let id = try await store.createChat(providerId: p, modelId: m, workspaceId: folder, mode: mode, effort: effort)
                store.drafts.clear(DraftStore.newChat)
                // The chat's own model sends the first message, so a failure shows
                // there and the text comes back in its composer.
                if !first.isEmpty { app.firstMessages[id] = first }
                opened(id)
            } catch let e as RelayError where !e.fromComputer && !first.isEmpty {
                // No answer: the chat starts from the outbox when the computer is back.
                startLater(p, m, first)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    /// Offline: the chat and its first prompt wait in the outbox, listed under
    /// Waiting to send, and start when the computer is back.
    private func startLater(_ p: String, _ m: String, _ first: String) {
        guard !first.isEmpty else { return }
        store.outbox.add(chatId: nil, text: first, newChat: NewChatSpec(providerId: p, modelId: m, workspaceId: folder, mode: mode?.rawValue, effort: effort?.rawValue))
        store.drafts.clear(DraftStore.newChat)
        text = ""
        refusal = nil
        store.flushOutbox()
        dismiss()
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
