import NekkoKit
import NekkoProtocol
import SwiftUI

// MARK: Connectors

/// The services this iPhone is connected to (decision 0058): a git provider for
/// Pull requests, and the project tools you work in. Tokens stay in this
/// iPhone's Keychain and go only to their own service.
struct ConnectorsView: View {
    @Environment(ConnectorsModel.self) private var connectors
    @Environment(\.palette) private var palette
    @State private var connecting: PhoneConnectors.Kind?
    @State private var removing: PhoneConnector?

    var body: some View {
        List {
            Section {
                Text("Connect the services you work in. Each token stays in this iPhone’s Keychain and is sent only to its own service, never to a computer, the relay or Nekko Cloud. Your computers keep their own connectors.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .listRowBackground(Color.clear)
            }
            section(.git, title: "Git providers")
            if connectors.git.count > 1 {
                Section {
                    Picker("Pull requests from", selection: Binding(get: { connectors.gitProvider?.kind ?? "" }, set: { connectors.selectGit($0) })) {
                        ForEach(connectors.git) { c in Text(c.label).tag(c.kind) }
                    }
                    .accessibilityIdentifier("connectors.gitPicker")
                } footer: {
                    Text("The Pull requests screen lists this provider’s.").foregroundStyle(palette.inkSoft)
                }
            }
            section(.tasks, title: "Project management")
        }
        .appBackground()
        .navigationTitle("Connectors")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $connecting) { kind in ConnectSheet(kind: kind) }
        .confirmationDialog("Disconnect \(removing?.label ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { if let c = removing { connectors.disconnect(c.kind) } }
        } message: {
            Text("Its token is deleted from this iPhone.")
        }
        .accessibilityIdentifier("connectors.view")
    }

    private func section(_ category: PhoneConnectors.Category, title: LocalizedStringKey) -> some View {
        Section {
            ForEach(PhoneConnectors.kinds.filter { $0.category == category }) { kind in row(kind) }
        } header: { SectionHeader(title) }
    }

    private func row(_ kind: PhoneConnectors.Kind) -> some View {
        let c = connectors.connector(kind.id)
        return HStack(spacing: 12) {
            ConnectorMark(kind: kind)
            VStack(alignment: .leading, spacing: 2) {
                Text(kind.label).foregroundStyle(palette.ink)
                if let c {
                    Text(c.account.map { String(localized: "Connected as \($0)") } ?? String(localized: "Connected"))
                        .font(.caption).foregroundStyle(palette.success)
                } else {
                    Text(kind.category == .git ? String(localized: "Pull requests and checks") : String(localized: "Your open tasks"))
                        .font(.caption).foregroundStyle(palette.inkSoft)
                }
            }
            Spacer(minLength: 8)
            if c != nil {
                Menu {
                    Button { connecting = kind } label: { Label("New token", systemImage: "key") }
                    Button(role: .destructive) { removing = c } label: { Label("Disconnect", systemImage: "xmark.circle") }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(palette.inkSoft).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Options for \(kind.label)")
            } else {
                Button("Connect") { connecting = kind }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("connectors.connect.\(kind.id)")
            }
        }
        .accessibilityElement(children: .contain)
        .swipeActions {
            if let c { Button(role: .destructive) { removing = c } label: { Label("Disconnect", systemImage: "xmark.circle") } }
        }
    }
}

/// A connector's brand mark on a quiet tile, as the desktop's connector cards
/// draw it (`connectorIcons.tsx`): the service's own colours, and GitHub and
/// Linear, whose marks are monochrome, in the ink so they read in both themes.
/// A kind with no mark yet falls back to the kind of service it is.
struct ConnectorMark: View {
    let kind: PhoneConnectors.Kind
    var size: CGFloat = 30
    @Environment(\.palette) private var palette

    /// Marks drawn in the ink rather than their own colour.
    static let monochrome: Set<String> = ["github", "linear"]

    var body: some View {
        Group {
            if UIImage(named: "connector-\(kind.id)") != nil {
                Image("connector-\(kind.id)")
                    .renderingMode(Self.monochrome.contains(kind.id) ? .template : .original)
                    .resizable().scaledToFit()
                    .foregroundStyle(palette.ink)
                    .frame(width: size * 0.6, height: size * 0.6)
            } else {
                Image(systemName: kind.category == .git ? "arrow.triangle.branch" : "checklist")
                    .font(.system(size: size * 0.5, weight: .semibold))
                    .foregroundStyle(palette.accent)
            }
        }
        .frame(width: size, height: size)
        .background(palette.surface2, in: RoundedRectangle(cornerRadius: size * 0.28))
        .accessibilityHidden(true)
        .accessibilityIdentifier("connectors.mark.\(kind.id)")
    }
}

/// Connect one service: its fields and token. Connect checks the token with a
/// real call and keeps nothing if the service turns it down.
struct ConnectSheet: View {
    let kind: PhoneConnectors.Kind
    @Environment(ConnectorsModel.self) private var connectors
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]
    @State private var token = ""
    @State private var busy = false
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            Form {
                if !kind.fields.isEmpty {
                    Section {
                        ForEach(kind.fields) { f in
                            TextField(f.label, text: Binding(get: { values[f.id] ?? "" }, set: { values[f.id] = $0 }),
                                      prompt: Text(f.placeholder))
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .keyboardType(f.isURL ? .URL : f.id == "email" ? .emailAddress : .default)
                                .accessibilityIdentifier("connect.field.\(f.id)")
                        }
                    }
                }
                Section {
                    SecureField(kind.tokenName, text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("connect.token")
                } header: { SectionHeader("Token") } footer: {
                    Text(kind.hint + " " + String(localized: "Kept in this iPhone’s Keychain, on this device only."))
                        .foregroundStyle(palette.inkSoft)
                }
                if let failed {
                    Section { Label(failed, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
                }
            }
            .appBackground()
            .keyboardDoneButton()
            .navigationTitle("Connect \(kind.label)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button("Connect") { Task { await connect() } }
                            .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("connect.save")
                    }
                }
            }
            .onAppear {
                // Reconnecting keeps the address and email it had.
                if let c = connectors.connector(kind.id) { values = c.settings }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func connect() async {
        busy = true
        failed = nil
        defer { busy = false }
        do {
            _ = try await connectors.connect(kind: kind.id, token: token, settings: values)
            token = ""
            dismiss()
        } catch {
            failed = error.localizedDescription
        }
    }
}
