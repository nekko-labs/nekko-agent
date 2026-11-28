import AuthenticationServices
import NekkoKit
import NekkoProtocol
import PhotosUI
import SwiftUI
import UIKit

// MARK: Where a chat runs

/// A place chats run, as a row and a heading name it: a paired computer (its
/// name, icon and colour, as on the desktop), or this iPhone.
struct ChatPlace: Equatable {
    let id: String
    let name: String
    /// The computer's icon (`computer-<icon>` in the asset catalog), when it has one.
    var icon: String?
    var phone = false
    let color: Int

    /// "This iPhone" (or iPad): chats that run here, on the phone's own providers.
    @MainActor static var phoneName: String {
        UIDevice.current.userInterfaceIdiom == .pad ? String(localized: "This iPad") : String(localized: "This iPhone")
    }

    @MainActor static var phonePlace: ChatPlace {
        ChatPlace(id: PhoneProviders.computerId, name: phoneName, phone: true, color: Int(ComputerColors.phone))
    }

    /// A paired computer, or this iPhone, by its id.
    @MainActor
    static func of(_ id: String?, store: ComputersStore) -> ChatPlace? {
        guard let id else { return nil }
        if id == PhoneProviders.computerId { return phonePlace }
        guard let i = store.computers.firstIndex(where: { $0.id == id }) else { return nil }
        let c = store.computers[i]
        return ChatPlace(id: c.id, name: c.name, icon: c.icon, color: Int(ComputerColors.computer(at: i)))
    }

    /// Every place in the list, in order: the paired computers, then this iPhone (including
    /// before provider setup) while its beta setting is on.
    @MainActor
    static func all(store: ComputersStore, phone: PhoneChats) -> [ChatPlace] {
        let computers = store.computers.indices.compactMap { of(store.computers[$0].id, store: store) }
        return phone.available ? computers + [phonePlace] : computers
    }
}

/// Where a chat runs, on its row: the place's icon (or a dot) in its colour, then its name.
/// The colour is only on the mark, so the name keeps the list's contrast.
struct PlaceChip: View {
    let place: ChatPlace
    var showIcon = true
    @ScaledMetric private var size: CGFloat = 11
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 4) {
            PlaceMark(place: place, showIcon: showIcon, size: size)
            Text(place.name).font(.caption2.weight(.medium)).foregroundStyle(palette.inkSoft).lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "On \(place.name)"))
    }
}

/// A place's mark: its icon, or this iPhone's, in its colour; a dot when there is no icon to show.
struct PlaceMark: View {
    let place: ChatPlace
    var showIcon = true
    var size: CGFloat = 11

    var body: some View {
        Group {
            if showIcon && place.phone {
                Image(systemName: "iphone").resizable().scaledToFit()
            } else if showIcon, let icon = place.icon {
                Image("computer-\(icon)").renderingMode(.template).resizable().scaledToFit()
            } else {
                Circle().padding(size * 0.2)
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(Color(hex: place.color))
        .accessibilityHidden(true)
    }
}

// MARK: A chat on this iPhone

/// A chat that runs on this iPhone (decision 0050): the conversation, a composer,
/// and its model. No tools and no computer: a straight conversation with the model.
struct PhoneChatView: View {
    let chatId: String
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var picking = false
    @State private var renaming = false
    @State private var renameText = ""
    @State private var confirmDelete = false
    @State private var typing = false
    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var images: [String] = []
    @State private var loadingPhotos = false
    @State private var photoError: String?
    @State private var viewing: PhotoSet?

    var body: some View {
        Group {
            if let chat = phone.chat(chatId) {
                transcript(chat)
                    .safeAreaInset(edge: .bottom, spacing: 0) { composer(chat) }
            } else {
                Text("This chat was deleted.").font(.subheadline).foregroundStyle(palette.inkSoft)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .appBackground()
        .floatingKeyboardDismiss()
        .navigationTitle(phone.chat(chatId)?.title ?? String(localized: "Chat"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { titleAndPlace }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .sheet(isPresented: $picking) {
            PhoneModelPicker(selected: phone.chat(chatId).map { ($0.providerId, $0.modelId) }) { p, m in
                phone.setModel(chatId, providerId: p, modelId: m)
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: PhoneProviders.maxImages, matching: .images)
        // Send waits for the photos, as in a computer chat.
        .task(id: photos) {
            guard !photos.isEmpty else { return }
            loadingPhotos = true
            let loaded = await ImageAttachments.load(photos)
            if !Task.isCancelled { images = loaded }
            loadingPhotos = false
        }
        .fullScreenCover(item: $viewing) { set in ImageViewer(photos: set.photos, index: set.index) }
        .alert(photoError ?? "", isPresented: Binding(get: { photoError != nil }, set: { if !$0 { photoError = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { phone.rename(chatId, to: renameText) }
        }
        .confirmationDialog("Delete this chat on \(ChatPlace.phoneName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                phone.delete(chatId)
                dismiss()
            }
        } message: {
            Text("It is removed from this device for good.")
        }
    }

    private func transcript(_ chat: PhoneChat) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(chat.messages) { m in message(m, last: m.id == chat.messages.last?.id) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.messages.last?.text) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: chat.messages.count) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        }
    }

    /// The title, and under it once where the chat runs: "model ⟶ This iPhone" (#2921, #2922).
    private var titleAndPlace: some View {
        let chat = phone.chat(chatId)
        return VStack(spacing: 0) {
            Text(chat?.title ?? String(localized: "Chat")).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            if let chat {
                HStack(spacing: 2) {
                    Text(verbatim: phone.models[chat.providerId]?.first { $0.id == chat.modelId }?.name ?? chat.modelId)
                        .lineLimit(1).truncationMode(.middle)
                    PlaceConnector()
                    Text(ChatPlace.phoneName).lineLimit(1).layoutPriority(1)
                }
                .font(.caption).foregroundStyle(palette.inkSoft)
                // Plain text to accessibility, like ChatView's subtitle: a custom element this
                // short fails the accessibility audit's hit-region check.
                .accessibilityRepresentation { Text(String(localized: "\(modelName(chat)) on \(ChatPlace.phoneName)")) }
                .accessibilityIdentifier("phoneChat.place")
            }
        }
        .frame(maxWidth: 260)
    }

    @ViewBuilder private func message(_ m: PhoneMessage, last: Bool) -> some View {
        switch m.role {
        case .user:
            VStack(alignment: .trailing, spacing: 6) {
                if let sent = m.images, !sent.isEmpty {
                    SentPhotos(photos: sent) { viewing = PhotoSet(photos: sent, index: $0, messageId: m.id) }
                }
                if !m.text.isEmpty {
                    HStack {
                        Spacer(minLength: 48)
                        MarkdownText(text: m.text, bubble: true, selectable: false).foregroundStyle(palette.userInk)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 18))
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("You: \(m.text)")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                if m.text.isEmpty && m.error == nil {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Thinking…").font(.footnote).foregroundStyle(palette.inkSoft)
                    }
                    .accessibilityElement(children: .combine)
                } else if !m.text.isEmpty {
                    MarkdownText(text: m.text, topics: true, askTail: !phone.running.contains(chatId)).foregroundStyle(palette.ink)
                }
                if let error = m.error {
                    Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    if last {
                        Button("Try again") { phone.retry(chatId) }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("phoneChat.retry")
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func composer(_ chat: PhoneChat) -> some View {
        let running = phone.running.contains(chatId)
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
        // Only models that can't take photos lose the button; unknown ones keep it.
        let takesPhotos = phone.acceptsImages(providerId: chat.providerId, modelId: chat.modelId)
        return VStack(spacing: 6) {
            // Always there once the provider has reported limits, quiet until they near (#2923).
            PhoneLimitLine(providerId: chat.providerId) { picking = true }.padding(.horizontal, 4)
            if loadingPhotos {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Adding photos…").font(.caption)
                }
                .foregroundStyle(palette.inkSoft)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !images.isEmpty {
                ComposerPhotos(photos: images) { index in
                    images.remove(at: index)
                    photos = []
                }
            }
            MarkdownComposerField(text: $text, focused: $typing, placeholder: "Message", identifier: "phoneChat.prompt",
                                  onPasteImages: takesPhotos ? pasteImages : {})
            HStack(alignment: .bottom, spacing: 8) {
            if takesPhotos {
                Menu {
                    Button { pickingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                    // Asked for by the user, so iOS shows its paste prompt only then.
                    Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                        .disabled(!UIPasteboard.general.hasImages)
                } label: {
                    ComposerGlyph(name: "plus").foregroundStyle(palette.inkSoft)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Add")
                .accessibilityIdentifier("phoneChat.add")
                .transition(.opacity)
            }
            Button { picking = true } label: {
                Image(systemName: "cpu").font(.body).foregroundStyle(palette.inkSoft)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Model: \(modelName(chat))")
            .accessibilityIdentifier("phoneChat.model")
            Spacer(minLength: 0)
            VoiceConversationButton(makeTarget: { .phone(chatId) })
            if running {
                Button { phone.stop(chatId) } label: {
                    Image(systemName: "stop.fill").font(.body.weight(.bold))
                        .frame(width: 36, height: 36)
                        .background(palette.surface2, in: Circle())
                        .foregroundStyle(palette.ink)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
                .accessibilityIdentifier("phoneChat.stop")
            } else {
                Button {
                    phone.send(chatId, text, images: takesPhotos ? images : [])
                    text = ""
                    images = []
                    photos = []
                } label: {
                    Image(systemName: "arrow.up").font(.body.weight(.bold))
                        .frame(width: 36, height: 36)
                        .background(empty ? palette.surface2 : palette.accent, in: Circle())
                        .foregroundStyle(empty ? palette.inkFaint : palette.onAccent)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(empty || loadingPhotos)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("phoneChat.send")
            }
        }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.bar)
        .animation(.easeOut(duration: 0.2), value: images.count)
    }

    /// Images on the clipboard, scaled like picked photos (at most four in the message).
    private func pasteImages() {
        let room = max(0, PhoneProviders.maxImages - images.count)
        let added = (UIPasteboard.general.images ?? []).prefix(room).compactMap { ImageAttachments.encode($0) }
        if added.isEmpty { photoError = String(localized: "There’s no image on the clipboard."); return }
        images += added
    }

    private var menu: some View {
        let chat = phone.chat(chatId)
        return Menu {
            Button { picking = true } label: { Label("Change model", systemImage: "cpu") }
            Button { renameText = chat?.title ?? ""; renaming = true } label: { Label("Rename", systemImage: "pencil") }
            Button { phone.setPinned(chatId, !(chat?.pinned ?? false)) } label: {
                Label(chat?.pinned == true ? "Unpin" : "Pin", systemImage: chat?.pinned == true ? "pin.slash" : "pin")
            }
            if chat?.archivedAt != nil {
                Button { phone.restore(chatId) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
            } else {
                Button { phone.archive(chatId) } label: { Label("Archive", systemImage: "archivebox") }
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Chat options")
        .accessibilityIdentifier("phoneChat.menu")
        .disabled(chat == nil)
    }

    private func modelName(_ chat: PhoneChat) -> String {
        let name = phone.models[chat.providerId]?.first { $0.id == chat.modelId }?.name ?? chat.modelId
        let provider = phone.provider(chat.providerId)?.label ?? chat.providerId
        return "\(name) · \(provider)"
    }
}

/// The photos a message was sent with, above its text; a tap opens them full screen.
struct SentPhotos: View {
    let photos: [String]
    var open: (Int) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(photos.enumerated()), id: \.offset) { i, source in
                SentPhoto(source: source, label: "Photo \(i + 1) of \(photos.count)") { open(i) }
            }
        }
        .accessibilityIdentifier("phoneChat.sentPhotos")
    }
}

private struct SentPhoto: View {
    let source: String
    let label: String
    let open: () -> Void
    @Environment(\.palette) private var palette
    @State private var thumbnail: UIImage?

    var body: some View {
        Button(action: open) {
            Group {
                if let thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    palette.surface2
                }
            }
            .frame(width: 96, height: 96).clipped()
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .task(id: source) { thumbnail = await PhotoThumbnails.shared.load(source).map { UIImage(cgImage: $0) } }
    }
}

/// The models of this iPhone's providers that are on, grouped by provider, under the
/// same All / Cloud / Local tabs as a computer's. Every provider here is a cloud API,
/// so Local says where local models run instead.
struct PhoneModelPicker: View {
    let selected: (String, String)?
    var pick: (String, String) -> Void
    @Environment(PhoneChats.self) private var phone
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var scope = ModelScope.all
    @State private var adding = false
    /// Models whose dated snapshots are showing (`provider::model`).
    @State private var unfolded: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                if phone.providers.filter(\.enabled).isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        PhoneCloudIllustration().frame(height: 100).accessibilityHidden(true)
                        Text("Chat without a computer").font(.headline)
                        Text("Connect your own cloud provider. Your key stays in this device’s Keychain.")
                            .font(.subheadline).foregroundStyle(palette.inkSoft)
                        Button { adding = true } label: { Label("Add a provider", systemImage: "plus") }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("phoneModel.addProvider")
                    }
                    .listRowBackground(Color.clear)
                } else if scope == .local {
                    Text("Local models run on a computer. Start the chat on a computer to use them.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                        .listRowBackground(Color.clear)
                        .accessibilityIdentifier("modelPicker.emptyScope")
                }
                ForEach(phone.providers.filter { $0.enabled && scope.includes($0) }) { p in
                    Section {
                        if let e = phone.modelErrors[p.id] {
                            Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                        }
                        let list = phone.models[p.id] ?? []
                        if list.isEmpty && phone.modelErrors[p.id] == nil {
                            ProgressView().frame(maxWidth: .infinity)
                        }
                        // Dated snapshots fold under the model they pin (#2925).
                        let byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                        ForEach(ModelSnapshots.fold(list.map(\.id))) { fold in
                            let key = "\(p.id)::\(fold.main)"
                            let open = unfolded.contains(key) || (selected?.0 == p.id && fold.dated.contains(selected?.1 ?? ""))
                            if let m = byId[fold.main] { row(p.id, m) }
                            if !fold.dated.isEmpty {
                                DatedVersionsToggle(count: fold.dated.count, open: open) {
                                    if unfolded.contains(key) { unfolded.remove(key) } else { unfolded.insert(key) }
                                }
                            }
                            if open {
                                ForEach(fold.dated, id: \.self) { id in
                                    if let m = byId[id] { row(p.id, m).padding(.leading, 16) }
                                }
                            }
                        }
                    } header: {
                        // Reload sits by the provider mark and name, and the key's limits under it once an answer reported them.
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                ProviderMarkImage(kind: p.kind, size: 16)
                                SectionHeader(LocalizedStringKey(p.label))
                                Spacer(minLength: 8)
                                Button("Reload") { Task { await phone.loadModels(p.id) } }
                                    .font(.caption.weight(.semibold)).foregroundStyle(palette.accent).textCase(nil)
                                    .accessibilityLabel("Reload models")
                                    .accessibilityIdentifier("phoneModel.reload")
                            }
                            PhoneLimitLine(providerId: p.id).textCase(nil)
                        }
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { ModelScopeTabs(scope: $scope) }
            .appBackground()
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $adding, onDismiss: { Task { await phone.loadAllModels() } }) { AddPhoneProviderSheet() }
            .task { await phone.loadAllModels() }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ providerId: String, _ m: PhoneModel) -> some View {
        Button {
            pick(providerId, m.id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.name).foregroundStyle(palette.ink)
                    if m.name != m.id { Text(m.id).font(.caption).foregroundStyle(palette.inkSoft) }
                }
                Spacer()
                // Context only where the provider lists it, never guessed (#2925).
                if let meta = ModelMeta.line(local: false, contextLength: m.contextLength) {
                    Text(verbatim: meta).font(.caption.monospacedDigit()).foregroundStyle(palette.inkSoft).lineLimit(1)
                }
                if selected?.0 == providerId && selected?.1 == m.id {
                    Image(systemName: "checkmark").foregroundStyle(palette.accent).accessibilityLabel("Selected")
                }
            }
        }
        .accessibilityIdentifier("phoneModel.row")
    }
}

/// Original, resizable SwiftUI artwork. No downloaded asset or external request.
private struct PhoneCloudIllustration: View {
    @Environment(\.palette) private var palette
    var body: some View {
        HStack(spacing: 16) {
            RoundedRectangle(cornerRadius: 12).stroke(palette.accent, lineWidth: 3)
                .frame(width: 48, height: 80)
                .overlay(alignment: .bottom) { Capsule().fill(palette.accent).frame(width: 16, height: 3).padding(8) }
            ForEach(0..<3) { _ in Circle().fill(palette.accent).frame(width: 4, height: 4) }
            Image(systemName: "cloud").font(.system(size: 52, weight: .light)).foregroundStyle(palette.accent)
        }.frame(maxWidth: .infinity)
    }
}

/// Add a provider to this iPhone. OpenRouter is one button: a browser sign-in
/// hands the key back. Kinds with a key page are guided: open it, copy the key,
/// come back and tap Paste, and the provider is checked and kept by itself.
/// Kinds that need an address keep the form. Add checks it works before keeping it.
struct AddPhoneProviderSheet: View {
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var kindId: String
    @State private var label: String
    @State private var url: String
    @State private var key = ""
    @State private var workspace = ""
    @State private var opened = false
    @State private var busy = false
    @State private var failed: String?

    /// A kind to start on, from a provider button; nil starts on the first.
    init(initialKind: String? = nil) {
        // More providers starts on the first key kind; ChatGPT has its own button.
        let k = initialKind.flatMap(PhoneProviders.kind) ?? PhoneProviders.kinds.first { !$0.plan } ?? PhoneProviders.kinds[0]
        _kindId = State(initialValue: k.id)
        _label = State(initialValue: k.label)
        _url = State(initialValue: initialKind != nil && k.urlRequired ? k.defaultUrl : "")
    }

    private var kind: PhoneProviders.Kind { PhoneProviders.kind(kindId) ?? PhoneProviders.kinds[0] }
    private var keySite: String? { kind.keyPage.flatMap { URL(string: $0)?.host() } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Provider", selection: $kindId) {
                        ForEach(PhoneProviders.kinds) { k in Text(k.label).tag(k.id) }
                    }
                    .accessibilityIdentifier("addPhoneProvider.kind")
                    if kind.urlRequired {
                        TextField("Name", text: $label)
                            .accessibilityIdentifier("addPhoneProvider.name")
                    }
                } footer: {
                    Text(kind.hint).foregroundStyle(palette.inkSoft)
                }
                if kind.plan {
                    // ChatGPT (#3244): the sign-in is the whole form; there is no key to paste.
                    Section {
                        Button { Task { await signInChatGPT() } } label: {
                            Text("Sign in with \(kind.label)").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                        .accessibilityIdentifier("addPhoneProvider.signInChatGPT")
                    } footer: {
                        Text("Approve in the browser and come back. This iPhone keeps its own sign-in in its Keychain; your computers keep theirs. OpenAI’s terms are written around its own apps, so this is offered as-is. An OpenAI API key works too.")
                            .foregroundStyle(palette.inkSoft)
                    }
                }
                if kind.signIn {
                    Section {
                        Button { Task { await signIn() } } label: {
                            Text("Sign in with \(kind.label)").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                        .accessibilityIdentifier("addPhoneProvider.signIn")
                    } footer: {
                        Text("Approve in the browser and the key comes back to this iPhone.").foregroundStyle(palette.inkSoft)
                    }
                }
                if kind.urlRequired && !kind.plan {
                    Section {
                        TextField(kind.defaultUrl, text: $url, axis: .vertical)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityIdentifier("addPhoneProvider.url")
                    } header: { SectionHeader("Address") }
                }
                if !kind.plan { Section {
                    if let page = kind.keyPage.flatMap(URL.init(string:)), let keySite {
                        Button("Open \(keySite)") { opened = true; openURL(page) }
                            .accessibilityIdentifier("addPhoneProvider.openKeyPage")
                    }
                    HStack {
                        SecureField(kind.keyOptional ? String(localized: "\(kind.keyName) (optional)") : kind.keyName, text: $key)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .onSubmit { Task { await add() } }
                            .accessibilityIdentifier("addPhoneProvider.key")
                        if key.isEmpty && kind.keyPage != nil {
                            // The system Paste button reads the clipboard without the paste prompt.
                            PasteButton(payloadType: String.self) { take($0.first) }
                                .labelStyle(.titleOnly)
                                .buttonBorderShape(.capsule)
                                .disabled(busy)
                                .accessibilityIdentifier("addPhoneProvider.paste")
                        }
                    }
                    if kind.id == "anthropic" {
                        TextField("Workspace ID (optional)", text: $workspace)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } header: { SectionHeader(kind.signIn ? "Or use a key" : "Key") } footer: {
                    Text(opened ? "Copy the key, come back and tap Paste. Nekko checks it and connects."
                                : "Kept in this iPhone’s Keychain, on this device only.").foregroundStyle(palette.inkSoft)
                } }
                if let failed {
                    Section { Label(failed, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
                }
            }
            .appBackground()
            .keyboardDoneButton()
            .navigationTitle("Add a provider")
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: kindId) { old, new in
                // The name follows the kind until it is typed over.
                if label == PhoneProviders.kind(old)?.label || label.isEmpty { label = PhoneProviders.kind(new)?.label ?? "" }
                if PhoneProviders.kind(new)?.urlRequired == true { url = PhoneProviders.kind(new)?.defaultUrl ?? "" } else { url = "" }
                opened = false
                failed = nil
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else if !kind.plan {
                        Button("Add") { Task { await add() } }
                            .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("addPhoneProvider.save")
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    /// A pasted key is checked and kept straight away.
    private func take(_ text: String?) {
        let pasted = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !pasted.isEmpty, !busy else { return }
        key = pasted
        Task { await add() }
    }

    /// OpenRouter's PKCE sign-in in the browser (the person's own session, so
    /// usually one tap), then the code is swapped for a key and the key added.
    private func signIn() async {
        busy = true
        failed = nil
        do {
            let verifier = SyncCrypto.base64url(E2E.randomBytes(32))
            let callback = try await webAuth.authenticate(
                using: PhoneProviders.openRouterAuthorizeURL(challenge: SyncCrypto.pkceChallenge(verifier)),
                callbackURLScheme: "nekko-agent", preferredBrowserSession: .shared)
            guard let code = PhoneProviders.openRouterCode(from: callback) else { throw PhoneProviders.Problem.signIn }
            key = try await phone.openRouterKey(code: code, verifier: verifier)
            busy = false
            await add()
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            busy = false
        } catch {
            busy = false
            failed = error.localizedDescription
        }
    }

    /// Sign in with ChatGPT (#3244): listen on this iPhone's loopback port for the page to come
    /// back, open the sign-in, swap the code for this iPhone's own tokens, and keep the provider
    /// (or replace its sign-in) once its plan's models load.
    private func signInChatGPT() async {
        busy = true
        failed = nil
        let state = ChatGPTSignIn.state()
        let verifier = SyncCrypto.base64url(E2E.randomBytes(32))
        let listener: ChatGPTCallbackListener
        do {
            listener = try ChatGPTCallbackListener(state: state)
            try await listener.start()
        } catch {
            busy = false
            failed = ChatGPTSignIn.Problem.portBusy.localizedDescription
            return
        }
        do {
            // The listener's answer sends the browser to nekko-agent://, which closes the sheet.
            _ = try await webAuth.authenticate(
                using: ChatGPTSignIn.authorizeURL(challenge: SyncCrypto.pkceChallenge(verifier), state: state),
                callbackURLScheme: "nekko-agent", preferredBrowserSession: .shared)
        } catch {
            // Closed by hand, perhaps after the code already came: the listener says.
        }
        listener.stop()
        let answer = await listener.wait()
        guard case .code(let code)? = answer else {
            busy = false
            if case .refused? = answer { failed = ChatGPTSignIn.Problem.cancelled.localizedDescription }
            return
        }
        do {
            key = try await phone.chatGPTTokens(code: code, verifier: verifier).encoded
            // Signing in again replaces the old sign-in; the provider and its chats stay.
            if let existing = phone.providers.first(where: { $0.kind == "chatgpt" }) {
                phone.setKey(existing.id, key)
                phone.setEnabled(existing.id, true)
                if let why = await phone.test(existing.id) { failed = why; busy = false; return }
                key = ""
                busy = false
                dismiss()
                return
            }
            busy = false
            await add()
        } catch {
            busy = false
            failed = error.localizedDescription
        }
    }

    /// Keep the provider only once it answers.
    private func add() async {
        busy = true
        failed = nil
        defer { busy = false }
        do {
            let p = try phone.add(kind: kindId, label: label, baseUrl: kind.urlRequired ? url : nil, key: key, workspaceId: workspace)
            if let why = await phone.test(p.id) {
                phone.remove(p.id)
                failed = why
                return
            }
            key = ""
            dismiss()
        } catch {
            failed = error.localizedDescription
        }
    }
}
