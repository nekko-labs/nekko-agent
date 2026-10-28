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
                    // A tap opens the computer's page (2026-10-24); the actions stay on swipe and touch-and-hold.
                    NavigationLink(value: Route.computer(c.id)) {
                        HStack(spacing: 10) {
                            Circle().fill(c.id == store.activeId ? dot : palette.inkFaint.opacity(0.5)).frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(c.name).font(.body.weight(.medium)).foregroundStyle(palette.ink)
                                    if c.id == app.prefs.defaultComputer {
                                        Image(systemName: "star.fill").font(.caption2).foregroundStyle(palette.warning)
                                            .accessibilityLabel("Opens at launch")
                                    }
                                }
                                Text(subtitle(c)).font(.caption).foregroundStyle(palette.inkFaint)
                            }
                        }
                    }
                    .accessibilityIdentifier("computers.row")
                    .accessibilityHint("Opens this computer's page")
                    .swipeActions {
                        Button(role: .destructive) { forgetting = c } label: { Label("Forget", systemImage: "trash") }
                        Button { name = c.name; renaming = c } label: { Label("Rename", systemImage: "pencil") }
                    }
                    .contextMenu {
                        if c.id != store.activeId { Button { store.connect(c.id) } label: { Label("Connect", systemImage: "bolt.horizontal") } }
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
        .appBackground()
        .navigationTitle("Computers")
        .alert("Rename computer", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $name)
            Button("Cancel", role: .cancel) {}
            Button("Save") { if let c = renaming { store.rename(c.id, to: name) } }
        }
        .forgetDialog($forgetting)
    }

    private func subtitle(_ c: Computer) -> String {
        let where_ = "\(routeName(c.route)) · \(c.relayHost)"
        return c.id == store.activeId ? "\(stateName(store.conn)) · \(where_)" : where_
    }

    private var dot: Color {
        switch store.conn {
        case .online: return palette.success
        case .connecting: return palette.running
        case .offline: return palette.warning
        case .denied: return palette.danger
        case .idle: return palette.inkFaint
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
    @State private var sendingFeedback = false
    @State private var voiceIntro = VoiceIntroGate()

    var body: some View {
        @Bindable var prefs = app.prefs
        Form {
            Section {
                ThemePicker(selection: $prefs.theme)
                NavigationLink(value: Route.simpleMode) {
                    LabeledContent("Simple mode", value: prefs.expertMode ? String(localized: "Expert") : String(localized: "Simple"))
                }
                .accessibilityIdentifier("settings.simpleMode")
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    LabeledContent("Language") {
                        Text(Locale.current.localizedString(forLanguageCode: Bundle.main.preferredLocalizations.first ?? "en") ?? "English")
                    }
                    .foregroundStyle(palette.ink, palette.inkSoft)
                }
                .accessibilityIdentifier("settings.language")
            } header: { SectionHeader("Appearance") } footer: {
                Text("The themes are the desktop’s. The language is chosen in this iPhone’s Settings for Nekko Agent: English, Español, Français, Deutsch, Português, 日本語 or 中文.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                Toggle("App lock (Face ID / passcode)", isOn: Binding(get: { prefs.appLock }, set: { on in
                    if on { prefs.appLock = true } else {
                        Task { if await app.lock.confirmDisable() { prefs.appLock = false; app.lock.disable() } }
                    }
                }))
                if store.active != nil {
                    // SK-6: the active computer's step-up (security keys, passkeys, codes).
                    NavigationLink(value: Route.security) {
                        Label("Security keys and codes", systemImage: "key.horizontal")
                    }
                    .accessibilityIdentifier("settings.security")
                    UntestedHardwareNote()
                }
            } header: { SectionHeader("Security") } footer: {
                Text("Asks on every open and every return, covers the app switcher preview, and keeps notifications free of chat details. What the Lock Screen shows is set in Live Activities below.")
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
                NavigationLink(value: Route.liveActivities) {
                    LabeledContent("Live Activities", value: prefs.liveActivityLevel.label)
                }
                .accessibilityIdentifier("settings.liveActivities")
                Toggle("Vibrate for approvals and questions", isOn: $prefs.hapticNeedsYou)
                Toggle("Vibrate when a reply finishes", isOn: $prefs.hapticDone)
            } header: { SectionHeader("While a chat runs") } footer: {
                Text("One card on the Lock Screen and in the Dynamic Island shows every running chat, with Allow / Deny for approvals.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                // Inline: both choices are short rows with a checkmark, never cut off.
                Picker("Microphone", selection: $prefs.dictationHold) {
                    Text("Tap to keep listening").tag(false)
                    Text("Hold to talk").tag(true)
                }
                .pickerStyle(.inline)
                Toggle("Use Whisper on the computer when available", isOn: $prefs.dictationOnComputer)
            } header: { SectionHeader("Dictation") } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text(prefs.dictationHold
                         ? "Hold the microphone while you speak and let go to stop. With VoiceOver, double-tap starts and double-tap again stops."
                         : "Tap the microphone and talk: it keeps listening through pauses until you tap stop, lock the phone, or leave the chat, and the screen stays on while it listens. Start with “Nekko” for a command, like “Nekko, send it”. Without Whisper on the computer, speech is turned into text on this iPhone only, never on a server.")
                        .foregroundStyle(palette.inkSoft)
                    Button("Watch how voice works") { voiceIntro.replay() }
                        .font(.footnote)
                        .accessibilityIdentifier("settings.voiceIntro")
                }
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
                Button { sendingFeedback = true } label: { Label("Send feedback", systemImage: "envelope") }
                    .accessibilityIdentifier("settings.feedback")
            } header: { SectionHeader("About") }
            Section {
                Button("Forget everything on this iPhone", role: .destructive) { confirmWipe = true }
            }
        }
        .appBackground()
        .navigationTitle("Settings")
        .sheet(isPresented: $sendingFeedback) { FeedbackSheet() }
        .sheet(isPresented: $voiceIntro.showing, onDismiss: { voiceIntro.closed(app.prefs) {} }) { VoiceIntroView() }
        .confirmationDialog("Forget all computers and keys?", isPresented: $confirmWipe, titleVisibility: .visible) {
            Button("Forget everything", role: .destructive) { app.forgetEverything() }
        }
    }
}

extension View {
    /// Confirm, then forget a computer on this iPhone (its pairing keys and saved chats).
    func forgetDialog(_ computer: Binding<Computer?>) -> some View {
        modifier(ForgetDialog(computer: computer))
    }
}

private struct ForgetDialog: ViewModifier {
    @Binding var computer: Computer?
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.confirmationDialog("Forget \(computer?.name ?? "this computer")?",
                                   isPresented: Binding(get: { computer != nil }, set: { if !$0 { computer = nil } }),
                                   titleVisibility: .visible, presenting: computer) { c in
            Button("Forget", role: .destructive) { app.forget(c.id) }
        } message: { _ in
            Text("This iPhone deletes its pairing keys and saved chats for it. To stop the computer accepting this phone, remove it in Settings → Remote access there too.")
        }
    }
}

/// The desktop's theme presets (ThemePresets.swift), plus following the computer.
struct ThemePicker: View {
    @Binding var selection: String
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationLink {
            ThemeList(selection: $selection)
        } label: {
            LabeledContent { Text(Self.name(selection)) } label: { Text("Theme") }
                .foregroundStyle(palette.ink, palette.inkSoft)
        }
        .accessibilityIdentifier("settings.theme")
    }

    static func name(_ id: String) -> String {
        switch id {
        case Prefs.matchComputer: return String(localized: "Match my computer")
        case "system": return String(localized: "Match this iPhone")
        case "light": return String(localized: "Light")
        case "dark": return String(localized: "Dark")
        default:
            guard let p = ThemePreset.find(id) else { return id }
            return p.family.map { "\($0) · \(p.label)" } ?? p.label
        }
    }
}

private struct ThemeList: View {
    @Binding var selection: String
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    private var named: [ThemePreset] { ThemePreset.all.filter { $0.family == nil && !$0.isBasic } }
    private var families: [String] { ThemePreset.all.compactMap(\.family).reduce(into: []) { if !$0.contains($1) { $0.append($1) } } }

    var body: some View {
        List {
            Section {
                ForEach([Prefs.matchComputer, "system", "light", "dark"], id: \.self, content: row)
            }
            Section {
                ForEach(named.map(\.id), id: \.self, content: row)
            } header: { SectionHeader("Desktop themes") } footer: {
                Text("Spooky also brings a fall app icon through Halloween.").foregroundStyle(palette.inkSoft)
            }
            Section {
                ForEach(families, id: \.self) { f in
                    ForEach(ThemePreset.all.filter { $0.family == f }.map(\.id), id: \.self, content: row)
                }
            } header: { SectionHeader("Experimental") }
        }
        .appBackground()
        .navigationTitle("Theme")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ id: String) -> some View {
        Button {
            selection = id
            dismiss()
        } label: {
            HStack {
                Text(ThemePicker.name(id)).foregroundStyle(palette.ink)
                Spacer()
                if selection == id { Image(systemName: "checkmark").foregroundStyle(palette.accent) }
            }
        }
        .accessibilityAddTraits(selection == id ? .isSelected : [])
    }
}
