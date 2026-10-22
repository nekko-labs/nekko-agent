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
                    .foregroundStyle(palette.inkSoft)
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
    @State private var testing = false
    @State private var testResult: (text: String, ok: Bool)?

    var body: some View {
        @Bindable var prefs = app.prefs
        Form {
            Section {
                Picker("Theme", selection: $prefs.theme) {
                    ForEach(Prefs.ThemeChoice.allCases) { Text($0.label).tag($0) }
                }
            } header: { SectionHeader("Appearance") }
            Section {
                Toggle("App lock (Face ID / passcode)", isOn: Binding(get: { prefs.appLock }, set: { on in
                    if on { prefs.appLock = true } else {
                        Task { if await app.lock.confirmDisable() { prefs.appLock = false; app.lock.disable() } }
                    }
                }))
            } header: { SectionHeader("Security") } footer: {
                Text("Asks on every open and every return, covers the app switcher preview, and keeps notifications and the Lock Screen free of chat details.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                Toggle("Keep the chat list when offline", isOn: Binding(get: { prefs.keepChatList }, set: { app.setKeepChatList($0) }))
                    .accessibilityIdentifier("settings.keepChatList")
                Toggle("Keep recent chats to read offline", isOn: Binding(get: { prefs.keepTranscripts }, set: { app.setKeepTranscripts($0) }))
                    .accessibilityIdentifier("settings.keepTranscripts")
            } header: { SectionHeader("Offline") } footer: {
                Text("While a computer can’t be reached, this iPhone shows its chat list and the last 20 chats you opened, as last seen. Photos aren’t kept, nothing is backed up, and turning a switch off deletes what it kept.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                Toggle("Approvals and questions", isOn: Binding(get: { prefs.notifyNeedsYou }, set: { app.setNotify(.needsYou, $0) }))
                    .accessibilityIdentifier("settings.notify.needsYou")
                Toggle("Finished replies", isOn: Binding(get: { prefs.notifyFinished }, set: { app.setNotify(.finished, $0) }))
                    .accessibilityIdentifier("settings.notify.finished")
                Toggle("Failed replies", isOn: Binding(get: { prefs.notifyFailed }, set: { app.setNotify(.failed, $0) }))
                    .accessibilityIdentifier("settings.notify.failed")
                Button {
                    testing = true
                    Task {
                        testResult = await app.sendTestNotification()
                        testing = false
                    }
                } label: {
                    HStack {
                        Label("Send a test notification", systemImage: "bell.badge")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(testing || store.conn != .online)
                .accessibilityIdentifier("settings.notify.test")
                if let r = testResult {
                    Text(r.text).font(.footnote).foregroundStyle(r.ok ? palette.inkSoft : palette.danger)
                        .accessibilityIdentifier("settings.notify.testResult")
                }
            } header: { SectionHeader("Notify me about") } footer: {
                Text(store.conn == .online
                     ? "The test goes from \(store.active?.name ?? "your computer") through its relay. Pushes from the relay say only what happened, never your messages. When an approval or a question is answered on the computer, its notification goes away here too."
                     : "Connect to \(store.active?.name ?? "a computer") to send a test.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                Toggle("Live Activities", isOn: $prefs.liveActivities)
                Toggle("Vibrate for approvals and questions", isOn: $prefs.hapticNeedsYou)
                Toggle("Vibrate when a reply finishes", isOn: $prefs.hapticDone)
            } header: { SectionHeader("While a chat runs") } footer: {
                Text("Running chats show on the Lock Screen and in the Dynamic Island, with Allow / Deny for approvals.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                // Inline: both choices are short rows with a checkmark, never cut off.
                Picker("Microphone", selection: $prefs.dictationHold) {
                    Text("Tap to start and stop").tag(false)
                    Text("Hold to talk").tag(true)
                }
                .pickerStyle(.inline)
                Toggle("Use Whisper on the computer when available", isOn: $prefs.dictationOnComputer)
            } header: { SectionHeader("Dictation") } footer: {
                Text(prefs.dictationHold
                     ? "Hold the microphone while you speak and let go to stop. With VoiceOver, double-tap starts and double-tap again stops."
                     : "Tap the microphone to start and tap stop when you’re done.")
                    .foregroundStyle(palette.inkSoft)
            }
            if store.active != nil {
                Section {
                    // The choice on its own line: beside the label, "Guardrails (ask for risky tools)" was cut off.
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Tools in new chats").accessibilityHidden(true)
                        Picker("Tools in new chats", selection: Binding(get: { store.pcSettings.effectiveMode }, set: { m in
                            Task { do { try await store.updatePcSettings(PcSettings.patch(mode: m)) } catch { self.error = error.localizedDescription } }
                        })) {
                            ForEach(PcSettings.ChatMode.allCases, id: \.self) { Text(modeName($0)).tag($0) }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
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
                } header: { SectionHeader("On \(store.active?.name ?? "your computer")") } footer: {
                    Text(store.pcSettings.known ? "Saved on the computer; the desktop shows the same." : "Connect to change these.")
                        .foregroundStyle(palette.inkSoft)
                }
                .disabled(!store.pcSettings.known || store.conn != .online)
            }
            Section {
                NavigationLink(value: Route.cloud) { Label("Nekko Cloud sync", systemImage: "lock.icloud") }
                    .accessibilityIdentifier("settings.cloud")
                NavigationLink(value: Route.computers) { Label("Paired computers", systemImage: "desktopcomputer") }
                NavigationLink(value: Route.connection) { Label("Connection", systemImage: "antenna.radiowaves.left.and.right") }
                Picker("Open at launch", selection: $prefs.defaultComputer) {
                    Text("The one used last").tag(String?.none)
                    ForEach(store.computers) { Text($0.name).tag(Optional($0.id)) }
                }
            } header: { SectionHeader("Computers") }
            Section {
                LabeledContent("App", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                if let v = store.hostVersion { LabeledContent("Nekko Agent on \(store.active?.name ?? "computer")", value: v) }
                LabeledContent("Phone protocol", value: store.hostProtocol.map { "\(PhoneProtocol.version) here, \($0) on the computer" } ?? "\(PhoneProtocol.version)")
                ProtocolBanner()
                LabeledContent("Transport", value: store.active.map { "\(routeName($0.route)), end-to-end encrypted" } ?? "–")
                Link("Remote access guide", destination: URL(string: "https://nekkoagent.com/docs/remote")!)
            } header: { SectionHeader("About") }
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
