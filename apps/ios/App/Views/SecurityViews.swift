import NekkoKit
import NekkoProtocol
import SwiftUI

// Step-up and the safety exits on the iPhone (SK-6, SK-8; spec
// `spec/platform/hardware-keys-step-up-and-remote-sign-out.md`).

/// The owner's note on every hardware-key surface: a caption, never a
/// modal. "let us know" opens the public issue tracker.
struct UntestedHardwareNote: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Text(Self.text)
            .font(.footnote)
            .foregroundStyle(palette.inkSoft)
            .tint(palette.accent)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("security.untestedNote")
    }

    static var text: AttributedString {
        var s = AttributedString(StepUp.untestedHardwareNote)
        if let r = s.range(of: "let us know") {
            s[r].link = StepUp.issuesURL
        }
        return s
    }
}

// MARK: - The step-up sheet

/// Shown when the computer answers a mode raise with `step-up-required`:
/// what is being confirmed and where, the security key (the system sheet
/// asks for the touch or the NFC tap), a passkey on this iPhone when the
/// computer has one, and a code. Cancel changes nothing.
struct StepUpSheet: View {
    let request: StepUpRequest
    let answer: (StepUpProof?) -> Void
    @Environment(\.palette) private var palette
    @State private var keys = SecurityKeys()
    @State private var code = ""
    @State private var usingCode: Bool
    @State private var busy = false
    @State private var problem: String?
    @FocusState private var codeFocused: Bool

    init(request: StepUpRequest, answer: @escaping (StepUpProof?) -> Void) {
        self.request = request
        self.answer = answer
        _usingCode = State(initialValue: !request.challenge.acceptsFido2)
        _problem = State(initialValue: request.problem)
    }

    private var challenge: StepUpChallenge { request.challenge }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "key.horizontal.fill").font(.title2).foregroundStyle(palette.accent)
                            .accessibilityHidden(true)
                        Text(request.action).font(.headline).foregroundStyle(palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("stepUp.action")
                        Text(usingCode
                             ? "Type the code from the authenticator app you set up for \(request.computer)."
                             : "Confirm with your security key: touch it, or hold it to the top of this iPhone.")
                            .font(.subheadline).foregroundStyle(palette.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 4)
                }
                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("stepUp.problem")
                    }
                }
                if usingCode {
                    codeSection
                } else {
                    keySection
                }
                Section {} footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("One confirmation covers five minutes on \(request.computer).").foregroundStyle(palette.inkSoft)
                        UntestedHardwareNote()
                    }
                }
            }
            .navigationTitle("Confirm it’s you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { answer(nil) }.accessibilityIdentifier("stepUp.cancel")
                }
            }
            .disabled(busy)
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private var keySection: some View {
        Section {
            if challenge.methods.contains(.securityKey) || !challenge.methods.contains(.passkey) {
                Button { use(.securityKey) } label: {
                    HStack {
                        Label("Use my security key", systemImage: "key.horizontal")
                        if busy { Spacer(); ProgressView() }
                    }
                }
                .accessibilityIdentifier("stepUp.securityKey")
            }
            if challenge.methods.contains(.passkey) {
                Button { use(.passkey) } label: { Label("Use a passkey on this iPhone", systemImage: "person.badge.key") }
                    .accessibilityIdentifier("stepUp.passkey")
            }
            if challenge.acceptsTotp {
                Button {
                    usingCode = true
                    codeFocused = true
                } label: { Label("Use a code", systemImage: "number") }
                    .accessibilityIdentifier("stepUp.useCode")
            }
        }
    }

    @ViewBuilder private var codeSection: some View {
        Section {
            TextField("6-digit code", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.title3.monospacedDigit())
                .focused($codeFocused)
                .onSubmit(submitCode)
                .accessibilityIdentifier("stepUp.code")
            Button("Confirm", action: submitCode)
                .disabled(StepUpProof.code(code) == nil)
                .accessibilityIdentifier("stepUp.confirmCode")
            if challenge.acceptsFido2 {
                Button("Use a security key instead") { usingCode = false }
            }
        } footer: {
            Text("Codes change every 30 seconds. After five wrong codes \(request.computer) waits a minute before taking another.")
                .foregroundStyle(palette.inkSoft)
        }
        .onAppear { codeFocused = true }
    }

    private func submitCode() {
        guard let proof = StepUpProof.code(code) else {
            problem = String(localized: "Type the six digits your authenticator app shows.")
            return
        }
        answer(proof)
    }

    private func use(_ kind: SecurityKeys.Kind) {
        guard let rpId = challenge.rpId, let bytes = challenge.bytes else { return }
        busy = true
        problem = nil
        let computer = request.computer
        let totp = challenge.acceptsTotp
        Task { @MainActor in
            defer { busy = false }
            do {
                let a = try await keys.assert(kind: kind, rpId: rpId, challenge: bytes, computer: computer)
                answer(.assertion(a))
            } catch SecurityKeys.Failure.cancelled {
                // Closed the system sheet: stay here.
            } catch SecurityKeys.Failure.unavailable(let why) {
                problem = why
                if totp { usingCode = true }
            } catch SecurityKeys.Failure.unusable(let why) {
                problem = why
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

extension View {
    /// Present the step-up sheet whenever the store asks for one (`AppModel.askStepUp`).
    func stepUpSheet() -> some View { modifier(StepUpPresenter()) }

    /// The confirmations and results of the safety exits (`AppModel.safetyAsk`).
    func safetyExitDialogs() -> some View { modifier(SafetyExitDialogs()) }
}

private struct StepUpPresenter: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.sheet(item: Binding(get: { app.stepUpRequest }, set: { if $0 == nil { app.answerStepUp(nil) } })) { r in
            StepUpSheet(request: r) { app.answerStepUp($0) }
                .environment(app)
                .environment(app.store)
        }
    }
}

// MARK: - Settings → Security

/// The active computer's step-up, as much as a phone may know (spec,
/// Security boundaries): on or off, and the kinds of method registered.
/// Registering from this iPhone appears only when the computer offers it.
struct SecuritySettingsView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var status: StepUpChallenge?
    @State private var error: String?
    @State private var loading = false
    @State private var keys = SecurityKeys()
    @State private var name = ""
    @State private var adding = false
    @State private var added: String?

    private var computer: String { store.active?.name ?? String(localized: "your computer") }

    var body: some View {
        Form {
            Section {
                if let status {
                    LabeledContent("Ask for a second factor", value: status.required ? String(localized: "On") : String(localized: "Off"))
                        .accessibilityIdentifier("security.state")
                    if status.methods.isEmpty {
                        Text("No security key, passkey or code is set up on \(computer).").foregroundStyle(palette.inkSoft)
                    }
                    ForEach(status.methods, id: \.self) { kind in
                        Label(kind.label, systemImage: Self.icon(kind)).foregroundStyle(palette.ink)
                    }
                } else if let error {
                    Text(error).font(.footnote).foregroundStyle(palette.danger)
                } else if loading || store.conn == .online {
                    ProgressView()
                } else {
                    Text("Connect to \(computer) to see how it’s protected.").foregroundStyle(palette.inkSoft)
                }
            } header: { SectionHeader("On \(computer)") } footer: {
                Text("With this on, raising a chat to Guardrails or YOLO from this iPhone asks for Face ID and then your security key or a code. One confirmation covers five minutes. Which keys are registered stays on \(computer): this iPhone only learns their kinds.")
                    .foregroundStyle(palette.inkSoft)
            }
            Section {
                if let offer = status?.registration {
                    TextField("Name, like YubiKey 5C", text: $name)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("security.name")
                    Button { add(.securityKey, offer) } label: { Label("Add a security key", systemImage: "key.horizontal") }
                    Button { add(.passkey, offer) } label: { Label("Add a passkey on this iPhone", systemImage: "person.badge.key") }
                    if adding { ProgressView() }
                    if let added { Text(added).font(.footnote).foregroundStyle(palette.inkSoft) }
                } else {
                    Text("Add a security key, a passkey or a one-time code on \(computer) in Settings → Security. Turning step-up off or removing a method is done there too.")
                        .foregroundStyle(palette.inkSoft)
                }
            } header: { SectionHeader("Add a method") } footer: {
                Text("A security key holds one credential per computer: touch it once on each computer you protect. Some older keys can only hold a few.")
                    .foregroundStyle(palette.inkSoft)
            }
            .disabled(store.conn != .online || adding)
            Section {} footer: { UntestedHardwareNote() }
        }
        .navigationTitle("Security")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.activeId) { await load() }
        .onChange(of: store.conn) { _, s in if s == .online { Task { await load() } } }
        .refreshable { await load() }
    }

    static func icon(_ kind: StepUpMethodKind) -> String {
        switch kind {
        case .securityKey: return "key.horizontal"
        case .passkey: return "person.badge.key"
        case .totp: return "number"
        }
    }

    @MainActor
    private func load() async {
        guard store.conn == .online else { return }
        loading = true
        defer { loading = false }
        do {
            status = try await store.stepUpStatus()
            error = nil
        } catch {
            status = nil
            self.error = error.localizedDescription
        }
    }

    private func add(_ kind: SecurityKeys.Kind, _ offer: StepUpRegistrationOffer) {
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = label.isEmpty ? (kind == .securityKey ? "Security key" : "iPhone passkey") : String(label.prefix(40))
        let computer = self.computer
        adding = true
        added = nil
        Task { @MainActor in
            defer { adding = false }
            do {
                let credential = try await keys.register(kind: kind, offer: offer, name: named, computer: computer)
                try await store.register(credential, offer: offer)
                added = String(localized: "Added “\(named)” on \(computer).")
                name = ""
            } catch SecurityKeys.Failure.cancelled {
            } catch SecurityKeys.Failure.unavailable(let why), SecurityKeys.Failure.unusable(let why) {
                added = why
            } catch {
                added = error.localizedDescription
            }
            await load()
        }
    }
}

// MARK: - Safety exits

/// The three safety exits for the active computer, for a menu (the
/// computer pill, the connection banner) or a list (the computer's page).
/// None asks for Face ID or a key: a safety exit is never harder than the attack.
struct SafetyExitItems: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store

    var body: some View {
        if let c = store.active {
            Button(role: .destructive) { app.safetyAsk = .signOut(c.id) } label: {
                Label("Sign out this phone", systemImage: "rectangle.portrait.and.arrow.right")
            }
            .accessibilityIdentifier("safety.signOut")
            Button(role: .destructive) { Task { await app.stopRemoteAccess() } } label: {
                Label("Stop remote access on \(c.name)", systemImage: "wifi.slash")
            }
            .disabled(store.conn != .online)
            .accessibilityIdentifier("safety.stopRemote")
            if store.quitFromPhone {
                Button(role: .destructive) { app.safetyAsk = .quit(c.id) } label: {
                    Label("Quit Nekko Agent on \(c.name)", systemImage: "power")
                }
                .disabled(store.conn != .online)
                .accessibilityIdentifier("safety.quit")
            }
        }
    }
}

/// What a safety exit asks before it acts, and what it says after.
enum SafetyAsk: Identifiable, Equatable {
    case signOut(String)
    case quit(String)

    var id: String {
        switch self {
        case .signOut(let c): return "signOut:\(c)"
        case .quit(let c): return "quit:\(c)"
        }
    }

    var computerId: String {
        switch self {
        case .signOut(let c), .quit(let c): return c
        }
    }
}

private struct SafetyExitDialogs: ViewModifier {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store

    private func name(_ id: String) -> String { store.computers.first { $0.id == id }?.name ?? String(localized: "your computer") }

    private var signingOut: SafetyAsk? { if case .signOut? = app.safetyAsk { return app.safetyAsk } else { return nil } }
    private var signOutName: String { signingOut.map { name($0.computerId) } ?? "" }
    private var quitting: SafetyAsk? { if case .quit? = app.safetyAsk { return app.safetyAsk } else { return nil } }

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Sign out of \(signOutName)?",
                                isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { app.safetyAsk = nil } }),
                                titleVisibility: .visible, presenting: signingOut) { ask in
                Button("Sign out this phone", role: .destructive) {
                    app.safetyAsk = nil
                    Task { await app.signOutThisPhone(ask.computerId) }
                }
            } message: { ask in
                Text("\(name(ask.computerId)) stops accepting this iPhone, and this iPhone forgets its pairing keys, drafts, waiting prompts and saved chats for it. Away from it, the sign-out is sent the next time this iPhone reaches it. To come back, pair again with a new code from the computer.")
            }
            .sheet(item: Binding(get: { quitting }, set: { if $0 == nil { app.safetyAsk = nil } })) { ask in
                QuitComputerSheet(computer: name(ask.computerId)) { go in
                    app.safetyAsk = nil
                    if go { Task { await app.quitComputer() } }
                }
                .presentationDetents([.medium])
            }
            .alert(app.safetyNotice ?? "", isPresented: Binding(get: { app.safetyNotice != nil }, set: { if !$0 { app.safetyNotice = nil } })) {
                Button("OK", role: .cancel) {}
            }
    }
}

/// The confirm sheet before *Quit Nekko Agent on the computer*.
struct QuitComputerSheet: View {
    let computer: String
    let done: (Bool) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "power").font(.largeTitle).foregroundStyle(palette.danger).accessibilityHidden(true)
            Text("Quit Nekko Agent on \(computer)?").font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
            Text("Running chats stop as on a normal quit, and the app and its engine close. Nothing on this iPhone can start it again: open Nekko Agent at \(computer) when you want it back.")
                .font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(role: .destructive) { done(true) } label: {
                Text("Quit Nekko Agent").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(palette.danger)
            .accessibilityIdentifier("safety.quit.confirm")
            Button { done(false) } label: { Text("Cancel").frame(maxWidth: .infinity).padding(.vertical, 6) }
                .buttonStyle(.bordered)
        }
        .padding(24)
        .background(palette.paper.ignoresSafeArea())
    }
}

/// *This computer* on the computer's page: the safety exits as rows, and
/// Settings → Security for the active computer.
struct ThisComputerSection: View {
    let computerId: String
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        if store.activeId == computerId, let c = store.active {
            Section {
                NavigationLink(value: Route.security) { Label("Security keys and codes", systemImage: "key.horizontal") }
                    .accessibilityIdentifier("computer.security")
                SafetyExitItems()
            } header: { SectionTitle(String(localized: "This computer")) } footer: {
                Text(store.quitFromPhone
                     ? "Stopping remote access or quitting can only be undone at \(c.name). Neither asks for a key: a way out must never be harder than getting in."
                     : "Stopping remote access can only be undone at \(c.name). Quitting from a phone is off there (Settings → Remote access).")
                    .foregroundStyle(palette.inkSoft)
            }
        } else {
            Section {
                Button(role: .destructive) { app.safetyAsk = .signOut(computerId) } label: {
                    Label("Sign out this phone", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } header: { SectionTitle(String(localized: "This computer")) } footer: {
                Text("Connect to this computer to stop remote access on it.").foregroundStyle(palette.inkSoft)
            }
        }
    }
}
