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
    @State private var imageChat = false
    @State private var imageParams = ImageChatParams()
    @State private var showImageSettings = false
    @State private var model: (String, String)?
    @State private var folder: String?
    @State private var choseFolder = false
    @State private var cachedSupportingFolders: [String] = []
    @State private var mode: PcSettings.ChatMode?
    /// A concrete draft choice; otherwise resolve the last-used choice for this computer.
    @State private var effort: Effort?
    /// The computer was picked here: keep offering the choice while its models load.
    @State private var pickedComputer = false
    @State private var text = ""
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var typing = false
    @State private var images: [String] = []
    @State private var loadingPhotos = false
    @State private var busy = false
    @State private var error: String?
    @State private var showModels = false
    @State private var foldersOpen = false
    @State private var restored = false
    /// Why the computer turned down a chat started offline (it came back here).
    @State private var refusal: String?
    @Environment(CloudSync.self) private var cloud
    @Environment(PhoneChats.self) private var phone
    /// The chat runs on this iPhone, on one of its own providers (decision 0050).
    @State private var onPhone = false
    @State private var phoneModel: (String, String)?
    @State private var pickingPhoneModel = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    /// Auto (2026-11-05): a chat on a local model starts on a free computer.
    /// Off once a computer is picked by hand, or when New chat opened from one computer's list.
    @State private var autoOn = true
    /// What Auto chose last, and why (the line under Run on).
    @State private var autoPick: MachinePick?
    @State private var autoFinding = false
    /// Bumped to run Auto again: a local model picked, or Automatic chosen.
    @State private var autoRun = 0
    /// Auto set the model (a local one), on the computer it moved to.
    @State private var autoChoseModel = false

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

    private var offline: Bool { !onPhone && store.conn != .online }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if offline {
                    note(Label(imageChat ? "Reconnect to generate images. Your image-chat draft stays here and will not be queued as text." : supportingFolders.isEmpty ? "\(store.active?.name ?? "Your computer") is \(store.conn == .offline ? "offline" : "reconnecting"). Start now and the chat begins when it’s back; it waits on this iPhone until then." : "Reconnect to start with your starred supporting folders. They require confirmation on this iPhone; your draft stays here.",
                               systemImage: "tray.and.arrow.up"), color: palette.inkSoft)
                        .accessibilityIdentifier("newChat.offlineNote")
                }
                if let refusal { note(Label(refusal, systemImage: "exclamationmark.bubble"), color: palette.danger) }
                // Above the box, as nothing goes below it (#1599).
                if let error { Text(error).font(.footnote).foregroundStyle(palette.danger) }
                // The desktop's clean start (2026-10-26): a peeking Nekko and a question over a glass message box.
                NewChatGreeting(paused: !text.isEmpty || !images.isEmpty)
                    .padding(.top, 36)
                    .zIndex(1)
                composer.padding(.top, -14)
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
        .sheet(isPresented: $pickingPhoneModel) {
            PhoneModelPicker(selected: phoneModel) { p, m in
                phoneModel = (p, m)
                app.prefs.lastModel[PhoneProviders.computerId] = "\(p)::\(m)"
            }
        }
        .sheet(isPresented: $showImageSettings) { ImageChatSettings(params: $imageParams) }
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (model?.0, model?.1)) { p, m in
                model = (p, m)
                autoChoseModel = false
                if let e = effort { effort = Effort.effective(e, for: m) }
                if let id = store.activeId { app.prefs.lastModel[id] = "\(p)::\(m)" }
                autoPick = nil
                autoRun += 1
            }
        }
        .sheet(isPresented: $foldersOpen) {
            NavigationStack {
                FoldersView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { foldersOpen = false } } }
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
        .onAppear(perform: pickPlace)
        .onAppear(perform: takeShared)
        .onAppear { autoOn = app.prefs.chatsFilter == nil }
        .task(id: autoRun) { await runAuto() }
        .task(id: cloud.fleetRefreshKey) {
            guard cloud.fleetEnabled, cloud.signedIn else { return }
            try? await cloud.loadMachines()
        }
        // The computer's providers may arrive after this screen opened.
        .onChange(of: isLocal) { _, local in if local && autoPick == nil && !autoFinding { autoRun += 1 } }
        // Kept on the phone like a chat's composer: text, photos, model, folder and tool policy.
        .onChange(of: imageChat) { _, _ in saveDraft() }
        .onChange(of: imageParams) { _, _ in saveDraft() }
        .onChange(of: text) { _, _ in saveDraft() }
        .onChange(of: images) { _, _ in saveDraft() }
        .onChange(of: model?.0) { _, _ in saveDraft() }
        .onChange(of: model?.1) { _, _ in saveDraft() }
        .onChange(of: folder) { _, _ in saveDraft(); autoRun += 1 }
        .onChange(of: choseFolder) { _, _ in saveDraft() }
        .onChange(of: cachedSupportingFolders) { _, _ in saveDraft() }
        .onChange(of: mode) { _, _ in saveDraft() }
        .onChange(of: effort) { _, _ in saveDraft() }
        // A chat started offline that the computer turned down comes back here.
        .onChange(of: store.drafts.drafts[DraftStore.newChat]) { _, d in adopt(d) }
        .onChange(of: app.sharedText) { _, _ in takeShared() }
        // The computer's defaults may arrive after this screen opened.
        .onChange(of: store.pcSettings.defaultWorkspaceIds) { _, _ in pickDefaultFolder() }
        .onChange(of: store.workspaces) { _, _ in pickDefaultFolder() }
        .onChange(of: store.defaults) { _, _ in pickDefault() }
    }

    /// The message, its photos, Add and Start, and below them the chat's options, on frosted glass.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            MarkdownComposerField(text: $text, focused: $typing,
                                  placeholder: imageChat ? "Describe an image to generate" : onPhone ? "Ask anything" : "What should your computer do?",
                                  identifier: "newChat.prompt", onPasteImages: pasteImages, boxed: false)
                .padding(.top, 20)
            if loadingPhotos {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Adding photos…").font(.caption)
                }.foregroundStyle(palette.inkSoft)
            }
            if !images.isEmpty {
                ComposerPhotos(photos: images) { index in
                    images.remove(at: index)
                    photos = []
                }
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
                // Chats on this iPhone send text only.
                .disabled(onPhone || imageChat)
                Spacer(minLength: 0)
                VoiceConversationButton(makeTarget: makeVoiceTarget, finished: { target in
                    switch target {
                    case .computer(let chat, _): chat.stop(); opened(chat.sessionId)
                    case .phone(let id): opened(id)
                    }
                })
                .disabled(imageChat)
                startButton
            }
            // The model, effort and where the chat runs: the box's bottom rows, never below it (#1599).
            options
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
                Text(imageChat ? "Connect to generate" : supportingFolders.isEmpty ? "Start when online" : "Connect to start").font(.footnote.weight(.semibold)).lineLimit(1)
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
            Picker("Chat kind", selection: $imageChat) {
                Text("Chat").tag(false)
                Text("Image").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("newChat.kind")
            if imageChat {
                Menu {
                    ForEach(store.computers) { computer in
                        Button(computer.name) { onPhone = false; place(computer.id) }
                    }
                } label: { chip(onPhone ? "Choose a computer" : store.active?.name ?? "Choose a computer", icon: "desktopcomputer") }
                Button { showImageSettings = true } label: {
                    chip(imageParams.modelId ?? "Choose an image model", icon: "photo.badge.plus", faint: imageParams.modelId == nil)
                }.accessibilityIdentifier("newChat.imageSettings")
                Text("\(imageParams.width)×\(imageParams.height) · \(imageParams.steps) steps · CFG \(imageParams.cfgScale, specifier: "%.1f")")
                    .font(.caption).foregroundStyle(palette.inkSoft)
                Text(onPhone ? "Image chats run on a paired computer, not this iPhone. Switch to Chat to choose a computer first." : !store.imageGeneration ? "Connect to an image-capable host. Older hosts need an update." : "Text prompts only · local image model · Change confirmation required")
                    .font(.caption).foregroundStyle(palette.inkSoft)
            } else { textOptions }
        }
    }

    private var textOptions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if onPhone {
                    Button { pickingPhoneModel = true } label: {
                        chip(phoneModel.map { phoneModelName($0) } ?? String(localized: "Choose a model"), icon: "cpu", faint: phoneModel == nil)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("newChat.model")
                } else if app.prefs.shows("model") || model == nil {
                    // Simple mode may hide the model; with none chosen yet the picker stays.
                    Button { showModels = true } label: {
                        chip(model.map { modelName($0) } ?? String(localized: "Choose a model"), icon: "cpu", faint: model == nil)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("newChat.model")
                }
                if !onPhone, let model, app.prefs.shows("effort") {
                    Menu {
                        Picker("Effort", selection: effortChoice) {
                            ForEach(Effort.levels(for: model.1), id: \.self) { e in
                                Text(e == Effort.recommended(for: model.1) ? String(localized: "\(effortName(e)) (Recommended)") : effortName(e)).tag(e)
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            EffortGauge(level: Effort.levels(for: model.1).firstIndex(of: selectedEffort),
                                        count: Effort.levels(for: model.1).count, size: 20)
                            Text(effortName(selectedEffort)).font(.footnote.weight(.medium)).lineLimit(1)
                        }
                        .foregroundStyle(palette.ink).padding(.horizontal, 10).frame(minHeight: 44)
                        .background(palette.surface, in: Capsule())
                    }
                    .accessibilityHint("How hard the model works on each reply. Higher takes longer.")
                    .accessibilityIdentifier("newChat.effort")
                }
            }
            HStack(spacing: 6) {
                // Where it runs, whenever there is a choice (2026-11-04): it starts on the
                // computer the list was showing, or the one used last, and every paired
                // computer is already connected, so picking another is instant.
                if isLocal || pickedComputer || store.computers.count + (phone.isSetUp ? 1 : 0) > 1 {
                    Menu {
                        Picker("Run on", selection: Binding(get: { autoShown ? Self.autoTag : onPhone ? PhoneProviders.computerId : store.activeId }, set: { if let id = $0 { place(id) } })) {
                            if autoOffered {
                                Label {
                                    Text("Automatic")
                                    Text("A free computer")
                                } icon: { Image(systemName: "sparkles") }
                                .tag(Optional(Self.autoTag))
                            }
                            ForEach(store.computers) { c in
                                Label {
                                    Text(c.name)
                                    Text(stateName(store.state(of: c.id)))
                                } icon: {
                                    if let icon = c.icon { Image("computer-\(icon)") } else { Image(systemName: cloud.machine(forComputer: c.id) == nil ? "desktopcomputer" : "cloud") }
                                }
                                .tag(Optional(c.id))
                            }
                            if phone.isSetUp {
                                Label {
                                    Text(ChatPlace.phoneName)
                                    Text("Its own models, no tools")
                                } icon: { Image(systemName: "iphone") }
                                .tag(Optional(PhoneProviders.computerId))
                            }
                        }
                    } label: {
                        if onPhone {
                            chip(ChatPlace.phoneName, icon: "iphone")
                        } else if autoShown {
                            chip(String(localized: "Auto · \(store.active?.name ?? String(localized: "Computer"))"), icon: "sparkles")
                        } else {
                            chip(store.active?.name ?? String(localized: "Computer"), icon: "desktopcomputer", computerIcon: store.active?.icon)
                        }
                    }
                    .accessibilityHint("Where the chat runs. Choosing another computer shows its models and folders; a local model runs on that computer’s own hardware.")
                    .accessibilityIdentifier("newChat.computer")
                }
                if !onPhone {
                    Menu {
                        Picker("Folder", selection: Binding(get: { folder }, set: { value in
                            choseFolder = true
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
                        Divider()
                        Button { foldersOpen = true } label: { Label("Manage folders", systemImage: "folder.badge.gearshape") }
                    } label: {
                        chip(folder.flatMap { id in store.workspaces.first { $0.id == id }?.name } ?? (folder == nil ? String(localized: "No folder") : String(localized: "Saved folder")), icon: "folder")
                    }
                    .accessibilityIdentifier("newChat.folder")
                    if app.prefs.shows("asks") {
                        ToolPolicyPicker(selection: toolsChoice)
                        .accessibilityHint("How the agent asks before it runs tools on \(store.active?.name ?? "your computer"). Ask when it matters is recommended for general use.")
                        .accessibilityIdentifier("newChat.tools")
                    }
                }
            }
            if autoShown, let line = autoLine {
                Label(line, systemImage: autoFinding ? "ellipsis" : "sparkles")
                    .font(.caption).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("newChat.auto")
            }
            if onPhone {
                Text("Runs on \(ChatPlace.phoneName) with your own key. No tools: it can’t see your computers or files.")
                    .font(.caption).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("newChat.phoneNote")
            } else if cloud.fleetConnected {
                let fleet = cloud.fleet(pairedComputerIds: Set(store.computers.map(\.id)))
                if let row = fleet.rows.first(where: { $0.computerId != nil && $0.explanation == nil }), let id = row.computerId {
                    Button { switchComputer(id) } label: {
                        chip(row.machine.name, icon: store.activeId == id ? "checkmark.icloud" : "cloud")
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(store.activeId == id ? .isSelected : [])
                    .accessibilityIdentifier("newChat.cloud")
                } else {
                    Text("No paired Nekko Cloud computers available. Pair an existing machine in Computers to use it here.")
                        .font(.caption).foregroundStyle(palette.inkSoft)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A solid, readable control over the decorative ground, as the desktop's clean-start controls.
    private func chip(_ title: String, icon: String, computerIcon: String? = nil, faint: Bool = false) -> some View {
        Label {
            Text(title)
        } icon: {
            if let computerIcon { ComputerGlyph(icon: computerIcon, size: 15) } else { Image(systemName: icon) }
        }
        .font(.footnote.weight(.medium)).lineLimit(1)
            .foregroundStyle(faint ? palette.inkSoft : palette.ink)
            .padding(.horizontal, 10).frame(minHeight: 34)
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
        if imageChat {
            return !busy && !offline && !onPhone && store.imageGeneration && imageParams.valid
                && imageParams.modelId != nil && images.isEmpty && !loadingPhotos
                && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if onPhone { return !busy && phoneModel != nil && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
        return !busy && !autoFinding && !loadingPhotos && model != nil && !(offline && (empty || !supportingFolders.isEmpty))
    }

    /// Images on the clipboard, scaled like picked photos (at most four in the message).
    private func pasteImages() {
        guard !imageChat else { error = "Image generation accepts text only. Attachments are not supported."; return }
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
        // Auto set a local model on a computer whose providers are still being read.
        return store.providers.first { $0.id == p }?.isLocal ?? autoChoseModel
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

    // MARK: Auto

    static let autoTag = "nekko.auto"

    /// Auto can choose here: a local model, more than one computer, and no folder (a folder decides the computer).
    private var autoOffered: Bool { !imageChat && !onPhone && isLocal && folder == nil && store.computers.count > 1 }
    private var autoShown: Bool { autoOn && autoOffered }

    private var autoLine: String? {
        if autoFinding { return String(localized: "Finding a free computer…") }
        guard let pick = autoPick, let name = store.active?.name else { return nil }
        switch pick.reason {
        case .free:
            if let busy = pick.skipped.first.flatMap({ id in store.computers.first { $0.id == id }?.name }) {
                return String(localized: "Auto picked \(name): \(busy) is busy.")
            }
            return String(localized: "Auto picked \(name): it’s free.")
        case .allBusy:
            return String(localized: "Every computer is busy, so Auto kept \(name), the one used last.")
        case .noneAvailable:
            return String(localized: "No other computer can run a local model now, so Auto kept \(name).")
        }
    }

    /// The Run on menu: Automatic, a computer, or this iPhone. Picking a place by hand turns Auto off.
    private func place(_ id: String) {
        if id == Self.autoTag {
            autoOn = true
            autoPick = nil
            autoRun += 1
            return
        }
        autoOn = false
        autoPick = nil
        autoRun += 1 // Cancel any probe still in flight, even if Auto is chosen again.
        switchPlace(id)
    }

    /// Ask every computer whether it is in use and move the chat to a free
    /// one, with a local model there: the one picked if it has it, else its
    /// last one, else one already loaded.
    private func runAuto() async {
        let run = autoRun
        let source = store.activeId
        autoFinding = false
        guard autoShown, !busy, let chosen = model else { return }
        autoFinding = true
        defer { if autoRun == run { autoFinding = false } }
        let pick = await store.pickMachine(lastUsed: source)
        guard !Task.isCancelled, autoRun == run, store.activeId == source, autoShown, !busy, model?.0 == chosen.0, model?.1 == chosen.1 else { return }
        guard let target = pick.computerId, target != store.activeId else { autoPick = pick; return }
        let last = app.prefs.lastModel[target].flatMap { s -> (String, String)? in
            guard let r = s.range(of: "::") else { return nil }
            return (String(s[..<r.lowerBound]), String(s[r.upperBound...]))
        }
        var prefer: [(String, String)] = [chosen]
        if let last { prefer.append(last) }
        guard let next = await store.localModel(on: target, prefer: prefer) else {
            guard !Task.isCancelled, autoShown else { return }
            // A model server may be enabled without any installed models.
            autoPick = MachinePick(computerId: store.activeId, reason: .noneAvailable, skipped: [])
            return
        }
        guard !Task.isCancelled, autoRun == run, store.activeId == source, autoShown, !busy, model?.0 == chosen.0, model?.1 == chosen.1 else { return }
        // Moved by Auto: the words carry over, the folder stays unset, and nothing is remembered as picked by hand.
        let words = text
        store.connect(target)
        model = next
        autoChoseModel = true
        effort = nil
        mode = nil
        // Supporting folders belong to the computer they were starred on (the target's defaults load with its folders).
        cachedSupportingFolders = []
        refusal = nil
        text = words
        store.drafts.set(DraftStore.newChat, current)
        autoPick = pick
    }

    /// Run on a paired computer, or on this iPhone.
    private func switchPlace(_ id: String) {
        if id == PhoneProviders.computerId {
            pickedComputer = true
            onPhone = true
            images = []
            photos = []
            Task { await pickPhoneDefault() }
            return
        }
        let wasPhone = onPhone
        onPhone = false
        if wasPhone && id == store.activeId { pickDefault(); return }
        switchComputer(id)
    }

    /// Start on this iPhone when the list shows only its chats, or when no computer is paired.
    private func pickPlace() {
        guard phone.isSetUp, app.prefs.chatsFilter == PhoneProviders.computerId || store.computers.isEmpty else { return }
        onPhone = true
        Task { await pickPhoneDefault() }
    }

    /// This iPhone's last model, else its first provider's first.
    private func pickPhoneDefault() async {
        guard phoneModel == nil else { return }
        if let last = app.prefs.lastModel[PhoneProviders.computerId], let r = last.range(of: "::") {
            let p = String(last[..<r.lowerBound])
            if phone.provider(p)?.enabled == true { phoneModel = (p, String(last[r.upperBound...])); return }
        }
        guard let first = phone.providers.first(where: \.enabled) else { return }
        var list = phone.models[first.id] ?? []
        if list.isEmpty { list = await phone.loadModels(first.id) }
        if phoneModel == nil, let m = list.first { phoneModel = (first.id, m.id) }
    }

    private func phoneModelName(_ m: (String, String)) -> String {
        let name = phone.models[m.0]?.first { $0.id == m.1 }?.name ?? m.1
        return "\(name) · \(phone.provider(m.0)?.label ?? m.0)"
    }

    private func switchComputer(_ id: String) {
        guard id != store.activeId else { return }
        pickedComputer = true
        let words = text
        store.connect(id)
        model = nil
        autoChoseModel = false
        effort = nil
        mode = nil
        choseFolder = false
        cachedSupportingFolders = []
        folder = app.prefs.lastFolder[id]
        pickDefaultFolder()
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

    private var supportingFolders: [String] {
        guard !choseFolder, folder != nil else { return [] }
        if store.conn != .online { return cachedSupportingFolders }
        let valid = Set(store.workspaces.map(\.id))
        return store.pcSettings.defaultWorkspaceIds.filter { $0 != folder && valid.contains($0) }
    }

    private var current: Draft {
        Draft(text: text, images: images, providerId: model?.0, modelId: model?.1, workspaceId: folder, mode: selectedTools.rawValue, effort: selectedEffort.rawValue, refusal: refusal, useDefaultFolders: !choseFolder, supportingWorkspaceIds: supportingFolders, imageParams: imageChat ? imageParams : nil)
    }

    private func restoreDraft() {
        guard !restored else { return }
        restored = true
        let draft = store.drafts.draft(DraftStore.newChat)
        folder = app.prefs.newChatFolder(computer: store.activeId, draft: draft)
        choseFolder = draft.useDefaultFolders.map { !$0 } ?? (draft.workspaceId != nil)
        cachedSupportingFolders = draft.supportingWorkspaceIds
        apply(draft)
        pickDefaultFolder()
    }

    private func pickDefaultFolder() {
        guard !choseFolder, store.conn == .online else { return }
        let valid = Set(store.workspaces.map(\.id))
        if let first = store.pcSettings.defaultWorkspaceIds.first(where: { valid.contains($0) }) {
            folder = first
            cachedSupportingFolders = store.pcSettings.defaultWorkspaceIds.filter { $0 != first && valid.contains($0) }
        } else { cachedSupportingFolders = [] }
    }

    private func apply(_ d: Draft) {
        imageChat = d.imageParams != nil
        if let params = d.imageParams { imageParams = params }
        if let defaults = d.useDefaultFolders {
            choseFolder = !defaults
            cachedSupportingFolders = d.supportingWorkspaceIds
        }
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

    private func makeVoiceTarget() async throws -> ConversationTarget {
        guard !imageChat else { throw RelayError("Image chats accept typed text prompts only.") }
        if onPhone {
            guard let picked = phoneModel else { throw RelayError("Choose a phone model before starting voice.") }
            return .phone(phone.create(providerId: picked.0, modelId: picked.1, first: ""))
        }
        guard let model else { throw RelayError("Choose a model before starting voice.") }
        guard let computer = store.activeId, store.conn == .online else { throw RelayError("Connect to your computer before starting voice.") }
        let id = try await store.createChat(providerId: model.0, modelId: model.1, workspaceId: folder,
                                            mode: selectedTools, effort: selectedEffort, supportingWorkspaceIds: supportingFolders)
        guard store.activeId == computer else { throw RelayError("The selected computer changed. Start voice again on the intended computer.") }
        let chat = ChatModel(sessionId: id, store: store)
        await chat.start()?.value
        if Task.isCancelled { chat.stop(); throw CancellationError() }
        return .computer(chat, computerId: computer)
    }

    private func start() {
        if imageChat { startImage(); return }
        guard !autoFinding else { return }
        if onPhone {
            guard let picked = phoneModel else { return }
            let (p, m) = picked
            let id = phone.create(providerId: p, modelId: m, first: text)
            app.prefs.lastModel[PhoneProviders.computerId] = "\(p)::\(m)"
            text = ""
            store.drafts.clear(DraftStore.newChat)
            opened(id)
            return
        }
        guard let model else { return }
        let (p, m) = model
        rememberChoices()
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = images
        let supporting = supportingFolders
        let sourceComputer = store.activeId
        if offline {
            guard supporting.isEmpty else {
                error = "Reconnect to start with your starred supporting folders. Your draft has not been sent."
                return
            }
            startLater(p, m, first)
            return
        }
        busy = true
        error = nil
        Task {
            do {
                let id = try await store.createChat(providerId: p, modelId: m, workspaceId: folder, mode: selectedTools, effort: selectedEffort, supportingWorkspaceIds: supporting)
                store.drafts.clear(DraftStore.newChat)
                // The chat's own model sends the first message, so a failure shows
                // there and the text comes back in its composer.
                if !first.isEmpty || !photos.isEmpty { app.firstMessages[id] = UnsentPrompt(text: first, skill: nil, images: photos) }
                opened(id)
            } catch let e as RelayError where !e.fromComputer && !(first.isEmpty && photos.isEmpty) {
                // Multi-folder starts need foreground authorization; never drop that context.
                if store.activeId == sourceComputer {
                    if supporting.isEmpty { startLater(p, m, first) }
                    else { error = "Reconnect to start with your starred supporting folders. Your draft has not been sent." }
                }
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func startImage() {
        guard canStart else { error = "Reconnect and choose a local image model. Remove attachments before generating."; return }
        let params = imageParams
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        error = nil
        Task {
            do {
                let id = try await store.createImageChat(params: params, workspaceId: folder)
                store.drafts.clear(DraftStore.newChat)
                store.drafts.set(id, Draft(text: first))
                app.firstMessages[id] = UnsentPrompt(text: first, skill: nil, images: [])
                opened(id)
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    /// Offline: the chat and its first prompt wait in the outbox, listed under
    /// Waiting to send, and start when the computer is back.
    private func startLater(_ p: String, _ m: String, _ first: String) {
        guard supportingFolders.isEmpty, !first.isEmpty || !images.isEmpty else { return }
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

/// The All / Cloud / Local tabs pinned over a model list, after the desktop picker's
/// Model source group. Every tab stays on offer; an empty one says so in the list.
struct ModelScopeTabs: View {
    @Binding var scope: ModelScope

    var body: some View {
        Picker("Model source", selection: $scope) {
            ForEach(ModelScope.allCases) { s in Text(s.title).tag(s) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("modelPicker.scope")
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }
}

extension ModelScope {
    var title: LocalizedStringKey {
        switch self {
        case .all: "All"
        case .cloud: "Cloud"
        case .local: "Local"
        }
    }
}

/// Every enabled provider's models on the computer, listed in parallel; starred first.
/// The tabs on top narrow it to the cloud APIs or the local model servers.
struct ModelPicker: View {
    let selected: (String?, String?)
    var pick: (String, String) -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""
    @State private var scope = ModelScope.all

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
                if groups.isEmpty && scope != .all {
                    Group {
                        if scope == .local { Text("No local model servers on this computer.") } else { Text("No cloud providers on this computer.") }
                    }
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("modelPicker.emptyScope")
                }
                ForEach(groups) { g in
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
            .safeAreaInset(edge: .top, spacing: 0) { ModelScopeTabs(scope: $scope) }
            .searchable(text: $query)
            .pawRefreshable { await store.loadAllModels(force: true) }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadAllModels() }
        }
    }

    private var favorites: [String] { scope.favorites(store.defaults.favoriteModels, providers: store.providers) }
    private var groups: [ModelGroup] { scope.groups(store.modelGroups) }

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
