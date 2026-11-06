import NekkoKit
import NekkoProtocol
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

    /// Every place in the list, in order: the paired computers, then this iPhone, even before provider setup.
    @MainActor
    static func all(store: ComputersStore, phone: PhoneChats) -> [ChatPlace] {
        let computers = store.computers.indices.compactMap { of(store.computers[$0].id, store: store) }
        return computers + [phonePlace]
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

// MARK: Getting started on this device

/// Original, static SwiftUI artwork: a private connection from this device to a cloud.
/// Decorative only; the adjacent text supplies the meaning at every text size.
private struct PhoneCloudIllustration: View {
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack {
            Ellipse().fill(palette.accent.opacity(0.08)).frame(width: 238, height: 112).offset(y: 12)
            Capsule().stroke(palette.accent.opacity(0.35), style: StrokeStyle(lineWidth: 2, dash: [3, 6]))
                .frame(width: 110, height: 38).rotationEffect(.degrees(-24)).offset(x: 6, y: -1)
            ZStack {
                RoundedRectangle(cornerRadius: 18).fill(palette.surface)
                RoundedRectangle(cornerRadius: 18).stroke(palette.accent.opacity(0.5), lineWidth: 2)
                VStack(spacing: 12) {
                    Capsule().fill(palette.inkFaint).frame(width: 24, height: 4)
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 27)).foregroundStyle(palette.accent)
                    Capsule().fill(palette.accent.opacity(0.25)).frame(width: 32, height: 4)
                }
            }
            .frame(width: 70, height: 112).rotationEffect(.degrees(-9)).offset(x: -68, y: 8)
            Image(systemName: "cloud.fill").font(.system(size: 64))
                .foregroundStyle(palette.accent.opacity(0.18))
                .overlay(Image(systemName: "cloud").font(.system(size: 64)).foregroundStyle(palette.accent))
                .offset(x: 66, y: -27)
            Image(systemName: "lock.fill").font(.system(size: 14, weight: .semibold))
                .foregroundStyle(palette.accent).padding(10)
                .background(palette.surface, in: Circle())
                .overlay(Circle().stroke(palette.line)).offset(x: 32, y: 40)
        }
        .frame(height: 156)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

/// The same setup invitation on the chat list, new chat and the device's models page.
struct PhoneProviderGettingStarted: View {
    var connect: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 14) {
            PhoneCloudIllustration()
            Text("Your next conversation starts here")
                .font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
            Text("Connect a cloud provider to chat on \(ChatPlace.phoneName), even without a paired computer.")
                .font(.subheadline).foregroundStyle(palette.inkSoft)
            Button(action: connect) {
                Label("Connect a cloud provider", systemImage: "plus")
                    .font(.body.weight(.semibold)).foregroundStyle(palette.onAccent)
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("phoneSetup.connect")
            Text("Your API key stays in this device’s Keychain and goes only to your provider. Chats here have no tools or access to your computers or files.")
                .font(.footnote).foregroundStyle(palette.inkSoft)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 440)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("phoneSetup.intro")
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
    @FocusState private var typing: Bool

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
        .navigationTitle(phone.chat(chatId)?.title ?? String(localized: "Chat"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { menu } }
        .sheet(isPresented: $picking) {
            PhoneModelPicker(selected: phone.chat(chatId).map { ($0.providerId, $0.modelId) }) { p, m in
                phone.setModel(chatId, providerId: p, modelId: m)
            }
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
                    placeNote(chat)
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

    /// Where the chat runs and what that means, above its first message.
    private func placeNote(_ chat: PhoneChat) -> some View {
        HStack(alignment: .top, spacing: 8) {
            PlaceMark(place: .phonePlace, size: 14).padding(.top, 2)
            Text("Runs on \(ChatPlace.phoneName) with \(modelName(chat)). It has no tools: it can’t see your computers or files.")
                .font(.footnote).foregroundStyle(palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("phoneChat.place")
    }

    @ViewBuilder private func message(_ m: PhoneMessage, last: Bool) -> some View {
        switch m.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                MarkdownText(text: m.text, bubble: true, selectable: false).foregroundStyle(palette.userInk)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("You: \(m.text)")
            }
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
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(alignment: .bottom, spacing: 8) {
            Button { picking = true } label: {
                Image(systemName: "cpu").font(.body).foregroundStyle(palette.inkSoft)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Model: \(modelName(chat))")
            .accessibilityIdentifier("phoneChat.model")
            TextField("Message", text: $text, axis: .vertical).lineLimit(1...6)
                .foregroundStyle(palette.ink)
                .focused($typing)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.line))
                .accessibilityIdentifier("phoneChat.prompt")
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
                    phone.send(chatId, text)
                    text = ""
                } label: {
                    Image(systemName: "arrow.up").font(.body.weight(.bold))
                        .frame(width: 36, height: 36)
                        .background(empty ? palette.surface2 : palette.accent, in: Circle())
                        .foregroundStyle(empty ? palette.inkFaint : palette.onAccent)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(empty)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("phoneChat.send")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.bar)
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
                Button { phone.complete(chatId) } label: { Label("Complete", systemImage: "checkmark.circle") }
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

    var body: some View {
        NavigationStack {
            List {
                if phone.providers.filter(\.enabled).isEmpty {
                    Text("Add a provider in Settings → Models on \(ChatPlace.phoneName) first.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
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
                        ForEach(list) { m in
                            Button {
                                pick(p.id, m.id)
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(m.name).foregroundStyle(palette.ink)
                                        if m.name != m.id { Text(m.id).font(.caption).foregroundStyle(palette.inkSoft) }
                                    }
                                    Spacer()
                                    if selected?.0 == p.id && selected?.1 == m.id {
                                        Image(systemName: "checkmark").foregroundStyle(palette.accent).accessibilityLabel("Selected")
                                    }
                                }
                            }
                            .accessibilityIdentifier("phoneModel.row")
                        }
                    } header: {
                        SectionHeader(LocalizedStringKey(p.label))
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { ModelScopeTabs(scope: $scope) }
            .appBackground()
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { await phone.loadAllModels() }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: Settings → Models on this iPhone

/// The providers this iPhone calls itself: add one with its key, turn one off,
/// test it, give it a new key, remove it. Keys stay in this iPhone's Keychain.
struct PhoneModelsView: View {
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @State private var adding = false
    @State private var rekeying: PhoneProvider?
    @State private var newKey = ""
    @State private var removing: PhoneProvider?
    @State private var tested: [String: String] = [:]
    @State private var testing: Set<String> = []

    var body: some View {
        List {
            if phone.providers.isEmpty {
                PhoneProviderGettingStarted { adding = true }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            Section {
                Text("Chats can run on \(ChatPlace.phoneName) itself, with no computer: the iPhone calls the provider with your own key. The key stays in this iPhone’s Keychain and is never sent to a computer, the relay or Nekko Cloud. These chats have no tools.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(phone.providers) { p in row(p) }
                Button { adding = true } label: { Label("Add a provider", systemImage: "plus") }
                    .accessibilityIdentifier("phoneModels.add")
            } header: { SectionHeader("Providers") }
            Section {
                ForEach(PhoneProviders.notOnPhone) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.label).foregroundStyle(palette.ink)
                        Text(item.why).font(.caption).foregroundStyle(palette.inkSoft)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: { SectionHeader("On a computer only") }
        }
        .appBackground()
        .navigationTitle("Models on \(ChatPlace.phoneName)")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $adding) { AddPhoneProviderSheet() }
        .alert("New key", isPresented: Binding(get: { rekeying != nil }, set: { if !$0 { rekeying = nil } })) {
            SecureField("Key", text: $newKey)
            Button("Cancel", role: .cancel) { newKey = "" }
            Button("Save") {
                if let p = rekeying {
                    phone.setKey(p.id, newKey)
                    Task { await test(p.id) }
                }
                newKey = ""
            }
        } message: {
            Text(rekeying.map { PhoneProviders.kind($0.kind)?.keyName ?? "" } ?? "")
        }
        .confirmationDialog("Remove \(removing?.label ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let p = removing { phone.remove(p.id) } }
        } message: {
            Text("Its key is deleted from this iPhone. Its chats stay to read.")
        }
        .task { await phone.loadAllModels() }
    }

    private func row(_ p: PhoneProvider) -> some View {
        Toggle(isOn: Binding(get: { p.enabled }, set: { phone.setEnabled(p.id, $0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.label).foregroundStyle(palette.ink)
                Text(status(p)).font(.caption).foregroundStyle(phone.modelErrors[p.id] != nil || tested[p.id] != nil ? palette.danger : palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(palette.accent)
        .accessibilityIdentifier("phoneModels.provider")
        .contextMenu {
            Button { Task { await test(p.id) } } label: { Label("Test", systemImage: "checkmark.seal") }
            Button { rekeying = p } label: { Label("New key", systemImage: "key") }
            Button(role: .destructive) { removing = p } label: { Label("Remove", systemImage: "trash") }
        }
        .swipeActions {
            Button(role: .destructive) { removing = p } label: { Label("Remove", systemImage: "trash") }
            Button { rekeying = p } label: { Label("New key", systemImage: "key") }.tint(palette.running)
        }
    }

    private func status(_ p: PhoneProvider) -> String {
        if testing.contains(p.id) { return String(localized: "Testing…") }
        if let e = tested[p.id] ?? phone.modelErrors[p.id] { return e }
        let count = phone.models[p.id]?.count ?? 0
        let models = count == 0 ? p.kindLabel : count == 1 ? String(localized: "\(p.kindLabel) · 1 model") : String(localized: "\(p.kindLabel) · \(count) models")
        return phone.hasKey(p.id) || PhoneProviders.kind(p.kind)?.keyOptional == true ? models : String(localized: "\(models) · no key")
    }

    private func test(_ id: String) async {
        testing.insert(id)
        tested[id] = nil
        tested[id] = await phone.test(id)
        testing.remove(id)
    }
}

/// Add a provider to this iPhone: its kind, a name, the address where the kind
/// needs one, and the key. Add checks it works before keeping it.
struct AddPhoneProviderSheet: View {
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var kindId = PhoneProviders.kinds[0].id
    @State private var label = PhoneProviders.kinds[0].label
    @State private var url = ""
    @State private var key = ""
    @State private var workspace = ""
    @State private var busy = false
    @State private var failed: String?

    private var kind: PhoneProviders.Kind { PhoneProviders.kind(kindId) ?? PhoneProviders.kinds[0] }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Provider", selection: $kindId) {
                        ForEach(PhoneProviders.kinds) { k in Text(k.label).tag(k.id) }
                    }
                    .accessibilityIdentifier("addPhoneProvider.kind")
                    TextField("Name", text: $label)
                        .accessibilityIdentifier("addPhoneProvider.name")
                } footer: {
                    Text(kind.hint).foregroundStyle(palette.inkSoft)
                }
                if kind.urlRequired {
                    Section {
                        TextField(kind.defaultUrl, text: $url, axis: .vertical)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityIdentifier("addPhoneProvider.url")
                    } header: { SectionHeader("Address") }
                }
                Section {
                    SecureField(kind.keyOptional ? String(localized: "\(kind.keyName) (optional)") : kind.keyName, text: $key)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("addPhoneProvider.key")
                    if kind.id == "anthropic" {
                        TextField("Workspace ID (optional)", text: $workspace)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } header: { SectionHeader("Key") } footer: {
                    Text("Kept in this iPhone’s Keychain, on this device only.").foregroundStyle(palette.inkSoft)
                }
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
                failed = nil
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button("Add") { Task { await add() } }
                            .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("addPhoneProvider.save")
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
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

#if DEBUG
/// Real empty screens in an owned UI-test install, without pairing or network startup.
struct PhoneSetupFixture: View {
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if ProcessInfo.processInfo.arguments.contains("-phoneSetupModels") {
                    PhoneModelsView()
                } else if ProcessInfo.processInfo.arguments.contains("-phoneSetupComputers") {
                    ComputersView()
                } else {
                    ChatsView(path: $path)
                }
            }
            .navigationDestination(for: Route.self) { route in
                if route == .phoneModels { PhoneModelsView() }
            }
        }
    }
}
#endif
