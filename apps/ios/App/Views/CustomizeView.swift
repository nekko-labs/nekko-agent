import NekkoKit
import NekkoProtocol
import SwiftUI

/// Experience first; connectors keep their existing phone-owned permission flow.
struct CustomizeView: View {
    @Environment(Prefs.self) private var prefs
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @State private var tab = "Experience"

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach(["Experience", "Connectors", "Skills"], id: \.self) { name in
                    Button { tab = name } label: {
                        Text(name).font(.subheadline.weight(.medium))
                            .foregroundStyle(tab == name ? palette.ink : palette.inkSoft)
                            .padding(.horizontal, 14).frame(minHeight: 44)
                            .background(tab == name ? palette.surface2 : .clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(tab == name ? .isSelected : [])
                    .accessibilityIdentifier("customize.\(name)")
                }
            }
            .padding(.vertical, 12)
            switch tab {
            case "Connectors": ConnectorsView()
            case "Skills": CustomizeSkillsView()
            default: experience
            }
        }
        .appBackground()
        .navigationTitle("Customize")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var experience: some View {
        Form {
            Section {
                Text("Make Nekko work your way").font(.title2.weight(.semibold))
                Text("Choose what you see and how your agents work.").foregroundStyle(palette.inkSoft)
            }
            Section {
                ExperienceModePicker()
                NavigationLink(value: Route.simpleMode) { Label("Visible controls and monitors", systemImage: "slider.horizontal.3") }
            } header: { SectionHeader("Agent output") } footer: {
                Text("Simple folds working steps away. Detailed shows them. Both have the same capabilities and permissions. This choice stays on this iPhone.")
            }
            Section {
                Picker("Tone", selection: Binding(get: { phone.tone }, set: { phone.setTone($0) })) {
                    ForEach(PhoneTone.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .accessibilityIdentifier("customize.tone")
            } header: { SectionHeader("Phone-hosted chats") } footer: {
                Text("Applies to the next reply from models running on this iPhone. Computer-hosted agents keep that computer’s tone and standing instructions.")
            }
            Section {
                ThemePicker(selection: Binding(get: { prefs.theme }, set: { prefs.theme = $0 }))
                NavigationLink(value: Route.settings) { Label("Text size and accessibility", systemImage: "textformat.size") }
            } header: { SectionHeader("Visual experience") }
            Section {
                NavigationLink(value: Route.settings) { Label("Agent behavior and permissions", systemImage: "checkmark.shield") }
                if !store.computers.isEmpty {
                    NavigationLink(value: Route.monitors) { Label("Monitors", systemImage: "gauge.with.dots.needle.50percent") }
                }
                Text("Tone and standing instructions for computer-hosted agents are managed in Customize on that computer. Changing this view never grants tool access.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
            } header: { SectionHeader("How agents work") }
        }
    }
}

struct ExperienceModePicker: View {
    @Environment(Prefs.self) private var prefs
    var body: some View {
        Picker("Agent output", selection: Binding(get: { prefs.expertMode }, set: { prefs.expertMode = $0 })) {
            Text("Simple").tag(false)
            Text("Detailed").tag(true)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("mode.switch")
    }
}

private struct CustomizeSkillsView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var skills: [SkillSummary] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                Text("Skills").font(.title2.weight(.semibold))
                Text("Reusable ways to work, from your connected computer. Use /name in a chat to run a skill.")
                    .foregroundStyle(palette.inkSoft)
            }
            if loading { ProgressView() }
            if let error { Text(error).foregroundStyle(palette.warning) }
            if !loading && error == nil && skills.isEmpty {
                Text("No skills available. Install skills in Customize on your computer.").foregroundStyle(palette.inkSoft)
            }
            ForEach(skills) { skill in
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "wand.and.stars").frame(width: 44, height: 44).background(palette.surface2, in: Circle())
                    VStack(alignment: .leading, spacing: 4) {
                        Text(skill.name).font(.headline)
                        Text(skill.description).font(.subheadline).foregroundStyle(palette.inkSoft)
                    }
                }
                .padding(.vertical, 8)
            }
        }
        .listStyle(.plain)
        .task(id: store.activeId) { await load() }
        .pawRefreshable { await load() }
    }

    @MainActor private func load() async {
        loading = true; error = nil; skills = []
        defer { loading = false }
        let computer = store.activeId
        do {
            let remote = try store.remote()
            let value = try await remote.call("skills:runnable")
            guard !Task.isCancelled, computer == store.activeId else { return }
            skills = SkillSummary.list(value)
        } catch { self.error = "Connect your computer to see its skills." }
    }
}
