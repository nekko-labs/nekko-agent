import NekkoKit
import NekkoProtocol
import PhotosUI
import SwiftUI

/// Start a chat on the computer: model (every enabled provider's, starred
/// first), effort, the computer a local model runs on, project folder, tool
/// policy, and the first message with its photos.
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
    /// A concrete draft choice; otherwise resolve the last-used choice for this computer.
    @State private var effort: Effort?
    /// The computer was picked here: keep offering the choice while its models load.
    @State private var pickedComputer = false
    @State private var text = ""
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @FocusState private var typing: Bool
    @State private var images: [String] = []
    @State private var loadingPhotos = false
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
    @Environment(\.colorScheme) private var scheme

    private var selectedEffort: Effort {
        let id = model?.1 ?? ""
        return effort.map { Effort.effective($0, for: id) }
            ?? app.prefs.newChatEffort(computer: store.activeId, model: id, settings: store.pcSettings)
    }

    private var selectedTools: PcSettings.ChatMode {
        mode ?? app.prefs.newChatTools(computer: store.activeId, settings: store.pcSettings)
    }

    private var effortChoice: Binding<Effort> {
        Binding(get: { selectedEffort }, set: { value in
            effort = value
            if let id = store.activeId { app.prefs.lastEffort[id] = value.rawValue }
        })
    }

    private var toolsChoice: Binding<PcSettings.ChatMode> {
        Binding(get: { selectedTools }, set: { value in
            mode = value
            if let id = store.activeId { app.prefs.lastTools[id] = value.rawValue }
        })
    }

    private func rememberChoices() {
        guard let id = store.activeId else { return }
        app.prefs.lastEffort[id] = selectedEffort.rawValue
        app.prefs.lastTools[id] = selectedTools.rawValue
    }

    private var offline: Bool { store.conn != .online }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if offline {
                    note(Label("\(store.active?.name ?? "Your computer") is \(store.conn == .offline ? "offline" : "reconnecting"). Start now and the chat begins when it’s back; it waits on this iPhone until then.",
                               systemImage: "tray.and.arrow.up"), color: palette.inkSoft)
                        .accessibilityIdentifier("newChat.offlineNote")
                }
                if let refusal { note(Label(refusal, systemImage: "exclamationmark.bubble"), color: palette.danger) }
                // The desktop's clean start (2026-10-26): a peeking Nekko and a question over a glass message box.
                NewChatGreeting(paused: !text.isEmpty || !images.isEmpty)
                    .padding(.top, 36)
                    .zIndex(1)
                composer.padding(.top, -14)
                options
                if let cloudError { Text(cloudError).font(.footnote).foregroundStyle(palette.danger) }
                if let error { Text(error).font(.footnote).foregroundStyle(palette.danger) }
            }
            .frame(maxWidth: 600)
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background { NewChatBackdrop() }
        .navigationTitle("New chat")
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (model?.0, model?.1)) { p, m in
                model = (p, m)
                if let e = effort { effort = Effort.effective(e, for: m) }
                if let id = store.activeId { app.prefs.lastModel[id] = "\(p)::\(m)" }
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 4, matching: .images)
        .task(id: photos) {
            guard !photos.isEmpty else { return }
            loadingPhotos = true
            let loaded = await ImageAttachments.load(photos)
            if !Task.isCancelled { images = loaded }
            loadingPhotos = false
        }
        .onAppear(perform: restoreDraft)
        .onAppear(perform: pickDefault)
        .onAppear(perform: takeShared)
        // Kept on the phone like a chat's composer: text, photos, model, folder and tool policy.
        .onChange(of: text) { _, _ in saveDraft() }
        .onChange(of: images) { _, _ in saveDraft() }
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

    /// The message, its photos, Add and Start, on frosted glass.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("What should your computer do?", text: $text, axis: .vertical).lineLimit(3...10)
                .foregroundStyle(palette.ink)
                .focused($typing)
                // The cat's paws rest on the box's top edge, above the first line.
                .padding(.top, 20)
                // The whole box takes the keyboard, not only the first line's height.
                .contentShape(Rectangle())
                .onTapGesture { typing = true }
                .accessibilityIdentifier("newChat.prompt")
            if loadingPhotos {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Adding photos…").font(.caption)
                }.foregroundStyle(palette.inkSoft)
            } else if !images.isEmpty {
                HStack {
                    Label(images.count == 1 ? "1 photo" : "\(images.count) photos", systemImage: "photo").font(.caption)
                    Button { images = []; photos = [] } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove photos")
                }.foregroundStyle(palette.inkSoft)
            }
            HStack(spacing: 6) {
                Menu {
                    Button { pickingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                    // Asked for by the user, so iOS shows its paste prompt only then.
                    Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                        .disabled(!UIPasteboard.general.hasImages)
                } label: {
                    Image(systemName: "plus").font(.body.weight(.semibold)).foregroundStyle(palette.ink)
                        .frame(width: 36, height: 36).background(palette.surface, in: Circle())
                        .overlay(Circle().stroke(palette.line))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Add")
                .accessibilityIdentifier("newChat.add")
                Spacer(minLength: 0)
                startButton
            }
        }
        .padding(12)
        .background {
            let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
            // The desktop's quiet glass: whiter in light themes, accent-tinted depth, no hard edge.
            shape.fill(palette.surface.opacity(scheme == .dark ? 0.35 : 0.6))
                .background(.ultraThinMaterial, in: shape)
                .shadow(color: palette.accent.opacity(scheme == .dark ? 0.45 : 0.38), radius: 25, y: 18)
                .shadow(color: .black.opacity(scheme == .dark ? 0.3 : 0.1), radius: 5, y: 2)
        }
    }

    @ViewBuilder private var startButton: some View {
        if offline {
            Button(action: start) {
                Text("Start when online").font(.footnote.weight(.semibold)).lineLimit(1)
                    .padding(.horizontal, 12).frame(minHeight: 36)
                    .background(canStart ? palette.accent : palette.surface2, in: Capsule())
                    .foregroundStyle(canStart ? palette.onAccent : palette.inkFaint)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canStart)
            .accessibilityIdentifier("newChat.start")
        } else {
            Button(action: start) {
                Group { if busy { ProgressView().tint(palette.onAccent) } else { Image(systemName: "arrow.up").font(.body.weight(.bold)) } }
                    .frame(width: 36, height: 36)
                    .background(canStart ? palette.accent : palette.surface2, in: Circle())
                    .foregroundStyle(canStart ? palette.onAccent : palette.inkFaint)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canStart)
            .accessibilityLabel("Start")
            .accessibilityIdentifier("newChat.start")
        }
    }

    /// The model and effort, where the chat runs and what it may do: computer, Nekko Cloud, folder and tool policy.
    private var options: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Button { showModels = true } label: {
                    chip(model.map { modelName($0) } ?? String(localized: "Choose a model"), icon: "cpu", faint: model == nil)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("newChat.model")
                if let model {
                    Menu {
                        Picker("Effort", selection: effortChoice) {
                            ForEach(Effort.levels(for: model.1), id: \.self) { e in
                                Text(e == Effort.recommended(for: model.1) ? String(localized: "\(effortName(e)) (Recommended)") : effortName(e)).tag(e)
                            }
                        }
                    } label: {
                        chip(effortName(selectedEffort), icon: "gauge.with.dots.needle.33percent")
                    }
                    .accessibilityHint("How hard the model works on each reply. Higher takes longer.")
                    .accessibilityIdentifier("newChat.effort")
                }
            }
            HStack(spacing: 6) {
                if isLocal || pickedComputer {
                    Menu {
                        Picker("Run on", selection: Binding(get: { store.activeId }, set: { if let id = $0 { switchComputer(id) } })) {
                            ForEach(store.computers) { c in Text(c.name).tag(Optional(c.id)) }
                        }
                    } label: { chip(store.active?.name ?? String(localized: "Computer"), icon: "desktopcomputer") }
                    .accessibilityHint("A local model runs on the computer’s own hardware. Choosing another computer shows its models and folders.")
                    .accessibilityIdentifier("newChat.computer")
                }
                Menu {
                    Picker("Folder", selection: Binding(get: { folder }, set: { value in
                        folder = value
                        if let id = store.activeId { app.prefs.lastFolder[id] = value }
                    })) {
                        Text("No folder").tag(String?.none)
                        ForEach(store.workspaces) { w in
                            VStack(alignment: .leading) {
                                Text(w.name)
                                if let path = w.path { Text(path) }
                            }.tag(Optional(w.id))
                        }
                    }
                } label: {
                    chip(folder.flatMap { id in store.workspaces.first { $0.id == id }?.name } ?? String(localized: "No folder"), icon: "folder")
                }
                .accessibilityIdentifier("newChat.folder")
                Menu {
                    Picker("Tools", selection: toolsChoice) {
                        ForEach(PcSettings.ChatMode.allCases, id: \.self) { m in
                            Text(m == .guardrails ? String(localized: "\(modeName(m)) (Recommended)") : modeName(m)).tag(m)
                        }
                    }
                } label: {
                    chip(modeName(selectedTools), icon: "checkmark.shield")
                }
                .accessibilityHint("How the agent asks before it runs tools on \(store.active?.name ?? "your computer"). Guardrails is recommended for general use.")
                .accessibilityIdentifier("newChat.tools")
            }
            if cloud.account?.canSync == true {
                // A chat can run on a Nekko Cloud machine instead of a paired computer (decision 0017).
                if let m = cloud.machines.first, let id = cloud.computerId(for: m), store.computers.contains(where: { $0.id == id }) {
                    Button { switchComputer(id) } label: {
                        chip(m.name, icon: store.activeId == id ? "checkmark.icloud" : "cloud")
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(store.activeId == id ? .isSelected : [])
                    .accessibilityIdentifier("newChat.cloud")
                } else {
                    Button { Task { await makeCloudMachine() } } label: {
                        if cloudBusy { ProgressView().frame(minHeight: 44) } else { chip(String(localized: "Run on a new Nekko Cloud machine"), icon: "cloud") }
                    }
                    .buttonStyle(.plain)
                    .disabled(cloudBusy)
                    .accessibilityHint("A sandboxed machine in the cloud, with no computer needed. It sees only what you put in its scope.")
                    .accessibilityIdentifier("newChat.cloud")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A solid, readable control over the decorative ground, as the desktop's clean-start controls.
    private func chip(_ title: String, icon: String, faint: Bool = false) -> some View {
        Label(title, systemImage: icon).font(.footnote.weight(.medium)).lineLimit(1)
            .foregroundStyle(faint ? palette.inkSoft : palette.ink)
            .padding(.horizontal, 12).frame(minHeight: 34)
            .background(palette.surface, in: Capsule())
            .overlay(Capsule().stroke(palette.line))
            .frame(minHeight: 44).contentShape(Rectangle())
    }

    private func note(_ label: Label<Text, Image>, color: Color) -> some View {
        label.font(.footnote).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    private var canStart: Bool {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
        return !busy && !loadingPhotos && model != nil && !(offline && empty)
    }

    /// Images on the clipboard, scaled like picked photos (at most four in the message).
    private func pasteImages() {
        let added = (UIPasteboard.general.images ?? []).prefix(max(0, 4 - images.count)).compactMap(ImageAttachments.encode)
        if added.isEmpty { error = String(localized: "There’s no image on the clipboard."); return }
        images += added
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

    private func effortName(_ e: Effort) -> String {
        switch e {
        case .low: return String(localized: "Low")
        case .medium: return String(localized: "Medium")
        case .normal: return String(localized: "Normal")
        case .high: return String(localized: "High")
        case .xhigh: return String(localized: "Extra high")
        case .max: return String(localized: "Max")
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
        mode = nil
        folder = app.prefs.lastFolder[id]
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
        Draft(text: text, images: images, providerId: model?.0, modelId: model?.1, workspaceId: folder, mode: selectedTools.rawValue, effort: selectedEffort.rawValue, refusal: refusal)
    }

    private func restoreDraft() {
        guard !restored else { return }
        restored = true
        let draft = store.drafts.draft(DraftStore.newChat)
        folder = app.prefs.newChatFolder(computer: store.activeId, draft: draft)
        apply(draft)
    }

    private func apply(_ d: Draft) {
        if !d.text.isEmpty { text = d.text }
        if !d.images.isEmpty { images = d.images }
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
        rememberChoices()
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = images
        if offline {
            startLater(p, m, first)
            return
        }
        busy = true
        error = nil
        Task {
            do {
                let id = try await store.createChat(providerId: p, modelId: m, workspaceId: folder, mode: selectedTools, effort: selectedEffort)
                store.drafts.clear(DraftStore.newChat)
                // The chat's own model sends the first message, so a failure shows
                // there and the text comes back in its composer.
                if !first.isEmpty || !photos.isEmpty { app.firstMessages[id] = UnsentPrompt(text: first, skill: nil, images: photos) }
                opened(id)
            } catch let e as RelayError where !e.fromComputer && !(first.isEmpty && photos.isEmpty) {
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
        guard !first.isEmpty || !images.isEmpty else { return }
        store.outbox.add(chatId: nil, text: first, images: images, newChat: NewChatSpec(providerId: p, modelId: m, workspaceId: folder, mode: selectedTools.rawValue, effort: selectedEffort.rawValue))
        store.drafts.clear(DraftStore.newChat)
        text = ""
        images = []
        photos = []
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
            .pawRefreshable { await store.loadAllModels(force: true) }
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

/// The desktop's rotating clean-start question beside the peeking Nekko (CleanStartGreeting.tsx).
/// Local copy only; it holds still while there's a draft, or with Reduce Motion.
struct NewChatGreeting: View {
    var paused = false
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index = 0

    static let questions: [LocalizedStringResource] = [
        "What should we work on?", "What would you like to make?", "What can we figure out together?",
        "What’s on your mind?", "What could use a fresh pair of eyes?", "What would you like to explore?",
        "What can we make simpler?", "What idea should we bring to life?", "Where should we start?",
        "What would you like a hand with?",
    ]

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            // Face clipping at y=25 meets the slot bottom: -2.5 + 25 × 2.5 = 60.
            // Only the downward-facing paws extend over the message box.
            Color.clear.frame(width: 64, height: 60)
                .overlay(alignment: .topLeading) { GreetingCat().frame(width: 80, height: 75).offset(x: -8, y: -2.5) }
            Text(Self.questions[index])
                .font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                .frame(maxWidth: 260, minHeight: 60, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .id(index)
                .transition(.opacity)
        }
        .frame(maxWidth: .infinity)
        .animation(.easeInOut(duration: 0.6), value: index)
        .task(id: paused || reduceMotion) {
            #if DEBUG
            // Keep the fixture's copy identical in before/after menu evidence.
            if ProcessInfo.processInfo.arguments.contains("-uiTestNewChat") { return }
            #endif
            guard !paused && !reduceMotion else { return }
            while (try? await Task.sleep(for: .seconds(8))) != nil {
                index = (index + 1) % Self.questions.count
            }
        }
    }
}

/// The desktop's new-chat frost: the theme's coloured ground under a slow drift through four
/// prism tints (its `new-chat-colors`, 120 s around). Still with Reduce Motion.
struct NewChatBackdrop: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var step = 0
    private static let prisms: [(Int, Int, Int)] = [
        (0x073B40, 0x154E50, 0xB38B3B), (0x362B7D, 0x623982, 0xAD4F77),
        (0x1E457E, 0x23697B, 0x4B9176), (0x743958, 0x975844, 0xA4894C),
    ]

    var body: some View {
        ZStack {
            AppBackdrop()
            ForEach(Self.prisms.indices, id: \.self) { i in
                let p = Self.prisms[i]
                LinearGradient(stops: [.init(color: Color(hex: p.0).opacity(0.12), location: 0),
                                       .init(color: Color(hex: p.1).opacity(0.10), location: 0.45),
                                       .init(color: Color(hex: p.2).opacity(0.10), location: 1)],
                               startPoint: .top, endPoint: .bottom)
                    .opacity(i == step ? 1 : 0)
            }
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 30), value: step)
        .accessibilityHidden(true)
        .task(id: reduceMotion) {
            guard !reduceMotion else { return }
            while (try? await Task.sleep(for: .seconds(30))) != nil { step = (step + 1) % Self.prisms.count }
        }
    }
}
