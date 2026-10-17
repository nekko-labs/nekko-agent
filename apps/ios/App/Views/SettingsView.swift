import NekkoKit
import NekkoProtocol
import SwiftUI

/// Paired computers: rename, switch, forget, and how each is reached.
struct ComputersView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var renaming: Computer?
    @State private var name = ""
    @State private var forgetting: Computer?

    var body: some View {
        List {
            Section {
                ForEach(store.computers) { c in
                    // A button, so VoiceOver says what tapping does; the connected
                    // computer isn't torn down and reconnected by a tap.
                    Button { if c.id != store.activeId { store.connect(c.id) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(c.name).font(.body.weight(.medium)).foregroundStyle(palette.ink)
                                if c.id == store.activeId { Text("Connected here").font(.caption2).foregroundStyle(palette.success) }
                                if c.id == app.prefs.defaultComputer {
                                    Image(systemName: "star.fill").font(.caption2).foregroundStyle(palette.warning)
                                        .accessibilityLabel("Opens at launch")
                                }
                            }
                            Text("\(routeName(c.route)) · \(c.relayHost)").font(.caption).foregroundStyle(palette.inkFaint)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(c.id == store.activeId ? .isSelected : [])
                    .accessibilityHint(c.id == store.activeId ? "" : "Connects to this computer")
                    .swipeActions {
                        Button(role: .destructive) { forgetting = c } label: { Label("Forget", systemImage: "trash") }
                        Button { name = c.name; renaming = c } label: { Label("Rename", systemImage: "pencil") }
                    }
                    .contextMenu {
                        Button { store.connect(c.id) } label: { Label("Connect", systemImage: "bolt.horizontal") }
                        Button { app.prefs.defaultComputer = c.id } label: { Label("Open at launch", systemImage: "star") }
                        Button { name = c.name; renaming = c } label: { Label("Rename", systemImage: "pencil") }
                        Button(role: .destructive) { forgetting = c } label: { Label("Forget", systemImage: "trash") }
                    }
                }
            } footer: {
                Text("Forgetting deletes this iPhone’s pairing keys. To stop the computer accepting this phone, remove it in Settings → Remote access there too.")
            }
            Section { NavigationLink(value: Route.pair) { Label("Pair another computer", systemImage: "plus") } }
        }
        .navigationTitle("Computers")
        .alert("Rename computer", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $name)
            Button("Cancel", role: .cancel) {}
            Button("Save") { if let c = renaming { store.rename(c.id, to: name) } }
        }
        .confirmationDialog("Forget \(forgetting?.name ?? "this computer")?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                            titleVisibility: .visible) {
            Button("Forget", role: .destructive) { if let c = forgetting { app.forget(c.id) } }
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var confirmWipe = false
    @State private var error: String?

    var body: some View {
        @Bindable var prefs = app.prefs
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $prefs.theme) {
                    ForEach(Prefs.ThemeChoice.allCases) { Text($0.label).tag($0) }
                }
            }
            Section {
                Toggle("App lock (Face ID / passcode)", isOn: Binding(get: { prefs.appLock }, set: { on in
                    if on { prefs.appLock = true } else {
                        Task { if await app.lock.confirmDisable() { prefs.appLock = false; app.lock.disable() } }
                    }
                }))
            } header: { Text("Security") } footer: {
                Text("Asks on every open and every return, covers the app switcher preview, and keeps notifications and the Lock Screen free of chat details.")
            }
            Section {
                Toggle("Notify when away", isOn: $prefs.notify)
                Toggle("Live Activities", isOn: $prefs.liveActivities)
                Toggle("Vibrate for approvals and questions", isOn: $prefs.hapticNeedsYou)
                Toggle("Vibrate when a reply finishes", isOn: $prefs.hapticDone)
            } header: { Text("Notifications") } footer: {
                Text("Running chats show on the Lock Screen and in the Dynamic Island, with Allow / Deny for approvals. Remote pushes from the relay never contain your messages.")
            }
            Section("Dictation") {
                Toggle("Use Whisper on the computer when available", isOn: $prefs.dictationOnComputer)
            }
            if store.active != nil {
                Section {
                    Picker("Tools in new chats", selection: Binding(get: { store.pcSettings.effectiveMode }, set: { m in
                        Task { do { try await store.updatePcSettings(PcSettings.patch(mode: m)) } catch { self.error = error.localizedDescription } }
                    })) {
                        ForEach(PcSettings.ChatMode.allCases, id: \.self) { Text(modeName($0)).tag($0) }
                    }
                    Picker("Chat’s main action", selection: Binding(get: { store.pcSettings.effectiveAction }, set: { a in
                        Task { do { try await store.updatePcSettings(PcSettings.patch(action: a)) } catch { self.error = error.localizedDescription } }
                    })) {
                        Text("Complete").tag(PcSettings.ChatAction.complete)
                        Text("Delete").tag(PcSettings.ChatAction.delete)
                    }
                    Toggle("Ask before deleting", isOn: Binding(get: { store.pcSettings.confirmDelete }, set: { on in
                        Task { do { try await store.updatePcSettings(PcSettings.patch(skipConfirm: !on)) } catch { self.error = error.localizedDescription } }
                    }))
                    if let error { Text(error).font(.footnote).foregroundStyle(palette.danger) }
                } header: { Text("On \(store.active?.name ?? "your computer")") } footer: {
                    Text(store.pcSettings.known ? "Saved on the computer; the desktop shows the same." : "Connect to change these.")
                }
                .disabled(!store.pcSettings.known || store.conn != .online)
            }
            Section("Computers") {
                NavigationLink(value: Route.computers) { Label("Paired computers", systemImage: "desktopcomputer") }
                Picker("Open at launch", selection: $prefs.defaultComputer) {
                    Text("The one used last").tag(String?.none)
                    ForEach(store.computers) { Text($0.name).tag(Optional($0.id)) }
                }
            }
            Section("About") {
                LabeledContent("App", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                if let v = store.hostVersion { LabeledContent("Nekko Agent on \(store.active?.name ?? "computer")", value: v) }
                LabeledContent("Transport", value: store.active.map { "\(routeName($0.route)), end-to-end encrypted" } ?? "–")
                Link("Remote access guide", destination: URL(string: "https://nekkoagent.com/docs/remote")!)
            }
            Section {
                Button("Forget everything on this iPhone", role: .destructive) { confirmWipe = true }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Forget all computers and keys?", isPresented: $confirmWipe, titleVisibility: .visible) {
            Button("Forget everything", role: .destructive) { app.forgetEverything() }
        }
    }
}
