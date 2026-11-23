import NekkoKit
import NekkoProtocol
import SwiftUI

/// What Models on This iPhone presents. Anthropic first shows its connection options.
private enum ModelsSheet: Identifiable {
    case anthropicChoice
    case add(String?)

    var id: String {
        switch self {
        case .anthropicChoice: return "anthropic-choice"
        case .add(let kind): return "add-\(kind ?? "any")"
        }
    }
}

/// The line under a provider's name: its test or model error, or what it is and how many
/// models it has. One place, so the list and the provider's page say the same thing.
@MainActor private func phoneProviderStatus(_ p: PhoneProvider, phone: PhoneChats, tested: String?, testing: Bool) -> (text: String, isError: Bool) {
    if testing { return (String(localized: "Testing…"), false) }
    if let e = tested ?? phone.modelErrors[p.id] { return (e, true) }
    if !p.enabled { return (String(localized: "Off"), false) }
    let count = phone.models[p.id]?.count ?? 0
    let models = count == 0 ? p.kindLabel : count == 1 ? String(localized: "\(p.kindLabel) · 1 model") : String(localized: "\(p.kindLabel) · \(count) models")
    let keyed = phone.hasKey(p.id) || PhoneProviders.kind(p.kind)?.keyOptional == true
    return (keyed ? models : String(localized: "\(models) · no key"), false)
}

// MARK: Settings → Models on this iPhone

/// The providers this iPhone calls itself: each an avatar row that opens its page, and the
/// popular providers as icon buttons that start the add flow already set to that provider.
/// Keys stay in this iPhone's Keychain.
struct PhoneModelsView: View {
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @State private var sheet: ModelsSheet?
    @State private var next: ModelsSheet?

    /// The providers most people reach for, in the desktop's order.
    private static let popular = ["chatgpt", "anthropic", "openai", "gemini", "openrouter", "ollama-cloud"]

    var body: some View {
        List {
            Section {
                Text("Chats run on \(ChatPlace.phoneName) itself, with your own key or ChatGPT sign-in, and have no tools. Keys and sign-ins stay in this iPhone’s Keychain.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .listRowBackground(Color.clear)
            }
            if !phone.providers.isEmpty {
                Section {
                    ForEach(phone.providers) { p in
                        NavigationLink(value: Route.phoneProvider(p.id)) { PhoneProviderRow(provider: p) }
                            .accessibilityIdentifier("phoneModels.provider")
                    }
                } header: { SectionHeader("Providers") }
            }
            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 20) {
                    ForEach(Self.popular, id: \.self) { id in
                        if let kind = PhoneProviders.kind(id) {
                            Button { start(id) } label: {
                                VStack(spacing: 8) {
                                    AvatarBadge(size: 48) { ProviderMarkImage(kind: id, size: 24) }
                                    Text(kind.label).font(.caption).foregroundStyle(palette.inkSoft)
                                        .lineLimit(1).minimumScaleFactor(0.8)
                                }
                                .frame(maxWidth: .infinity)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(kind.label))
                            .accessibilityIdentifier("phoneModels.add.\(id)")
                        }
                    }
                }
                .padding(.vertical, 8)
                Button { sheet = .add(nil) } label: { Label("More providers", systemImage: "plus").labelStyle(.quietRow) }
                    .accessibilityIdentifier("phoneModels.add")
            } header: { SectionHeader("Add a provider") }
        }
        .appBackground()
        .navigationTitle("Models on \(ChatPlace.phoneName)")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $sheet, onDismiss: { sheet = next; next = nil }) { s in
            switch s {
            case .anthropicChoice:
                AnthropicChoiceSheet { next = .add("anthropic"); sheet = nil }
            case .add(let kind):
                AddPhoneProviderSheet(initialKind: kind)
            }
        }
        .task { await phone.loadAllModels() }
    }

    /// Anthropic shows its options first; every other provider goes straight to its setup.
    private func start(_ kind: String) {
        sheet = kind == "anthropic" ? .anthropicChoice : .add(kind)
    }
}

/// An avatar row: the provider's mark, its name, and one status line.
struct PhoneProviderRow: View {
    let provider: PhoneProvider
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette

    var body: some View {
        let status = phoneProviderStatus(provider, phone: phone, tested: nil, testing: false)
        HStack(spacing: 12) {
            AvatarBadge { ProviderMarkImage(kind: provider.kind, size: 22) }
            VStack(alignment: .leading, spacing: 4) {
                Text(provider.label).font(.body.weight(.medium)).foregroundStyle(provider.enabled ? palette.ink : palette.inkFaint)
                Text(status.text).font(.caption).foregroundStyle(status.isError ? palette.danger : palette.inkFaint)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}

/// A provider's page: on or off, test it, give it a new key, remove it.
struct PhoneProviderDetailView: View {
    let providerId: String
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var rekeying = false
    @State private var newKey = ""
    @State private var removing = false
    @State private var tested: String?
    @State private var testing = false

    private var provider: PhoneProvider? { phone.providers.first { $0.id == providerId } }

    var body: some View {
        Group {
            if let p = provider { content(p) } else { Color.clear }
        }
        .appBackground()
        .navigationTitle(provider?.label ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func content(_ p: PhoneProvider) -> some View {
        let status = phoneProviderStatus(p, phone: phone, tested: tested, testing: testing)
        return List {
            Section {
                VStack(spacing: 8) {
                    AvatarBadge(size: 72) { ProviderMarkImage(kind: p.kind, size: 36) }
                    Text(p.label).font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                    Text(status.text).font(.footnote).foregroundStyle(status.isError ? palette.danger : palette.inkFaint)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("phoneProvider.status")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .listRowBackground(Color.clear)
            }
            Section {
                Toggle("Use on \(ChatPlace.phoneName)", isOn: Binding(get: { p.enabled }, set: { phone.setEnabled(p.id, $0) }))
                    .tint(palette.accent)
                    .accessibilityIdentifier("phoneProvider.enabled")
                Button { Task { await test(p.id) } } label: { Label("Test", systemImage: "checkmark.seal").labelStyle(.quietRow) }
                    .disabled(testing)
                    .accessibilityIdentifier("phoneProvider.test")
                Button { rekeying = true } label: { Label("New key", systemImage: "key").labelStyle(.quietRow) }
                    .accessibilityIdentifier("phoneProvider.newKey")
            }
            Section {
                Button("Remove", role: .destructive) { removing = true }
                    .accessibilityIdentifier("phoneProvider.remove")
            }
        }
        .alert("New key", isPresented: $rekeying) {
            SecureField("Key", text: $newKey)
            Button("Cancel", role: .cancel) { newKey = "" }
            Button("Save") {
                phone.setKey(p.id, newKey)
                newKey = ""
                Task { await test(p.id) }
            }
        } message: {
            Text(PhoneProviders.kind(p.kind)?.keyName ?? "")
        }
        .confirmationDialog("Remove \(p.label)?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                phone.remove(p.id)
                dismiss()
            }
        } message: {
            Text("Its key is deleted from this iPhone. Its chats stay to read.")
        }
        .task { await phone.loadAllModels() }
    }

    private func test(_ id: String) async {
        testing = true
        tested = nil
        tested = await phone.test(id)
        testing = false
    }
}

/// Anthropic's ways in. The API key works here. The Claude subscription is shown, dimmed,
/// with a sad Nekko and the reason: Anthropic does not allow it from a phone.
struct AnthropicChoiceSheet: View {
    var useKey: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: useKey) {
                        HStack(spacing: 12) {
                            AvatarBadge { ProviderMarkImage(kind: "anthropic", size: 22) }
                            VStack(alignment: .leading, spacing: 4) {
                                Text("API key").font(.body.weight(.medium)).foregroundStyle(palette.ink)
                                Text("From console.anthropic.com, kept in this iPhone’s Keychain.").font(.caption).foregroundStyle(palette.inkFaint)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .accessibilityIdentifier("anthropicChoice.apiKey")
                }
                Section {
                    HStack(spacing: 12) {
                        SadNekko(size: 56)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Claude subscription").font(.body.weight(.medium)).foregroundStyle(palette.inkFaint)
                            Text("Sorry, Anthropic doesn’t allow a Claude subscription to be used from a phone. Use it on a computer, or add an API key here.")
                                .font(.caption).foregroundStyle(palette.inkFaint)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Not available on this iPhone")
                    .accessibilityIdentifier("anthropicChoice.subscription")
                }
            }
            .appBackground()
            .navigationTitle("Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
