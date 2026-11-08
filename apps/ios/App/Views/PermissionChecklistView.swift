import SwiftUI

/// Shared by the final onboarding step and Settings. It never requests access
/// on appearance, and continuing does not imply every optional tool is enabled.
struct PermissionChecklistView: View {
    var finish: (() -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var permissions = PermissionChecklist()
    @State private var request: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if finish != nil { StepLabel(step: 3) }
                header
                group("Connection & alerts", subtitle: "Recommended for following your computer", items: [.notifications, .network])
                group("Make yourself at home", subtitle: "Optional tools. Turn on only what you use.", items: [.liveActivities, .camera, .microphone, .speech, .authentication, .photos])
                VStack(alignment: .leading, spacing: 10) {
                    Label("Your choice, every step", systemImage: "hand.raised")
                        .font(.headline).foregroundStyle(palette.ink)
                    Text("You can continue without granting access. Change your mind here or in system Settings at any time. Choosing photos or files uses the system picker and needs no blanket library or storage permission.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                    Button("Open system Settings") { PermissionChecklist.openSettings() }
                        .frame(minHeight: 44)
                        .disabled(permissions.busy != nil)
                        .accessibilityIdentifier("permissions.systemSettings")
                }
                .padding(18)
                .background(palette.surface2, in: RoundedRectangle(cornerRadius: 20))
                if let message = permissions.message {
                    Text(message).font(.subheadline).foregroundStyle(palette.inkSoft)
                        .accessibilityIdentifier("permissions.message")
                }
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(palette.paper)
        .navigationTitle(finish == nil ? "Permissions" : "")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if let finish {
                VStack(spacing: 4) {
                    Button(action: finish) {
                        Text("Continue").frame(maxWidth: .infinity).padding(.vertical, 6)
                            .foregroundStyle(palette.onAccent)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("permissions.continue")
                    Text("Optional permissions can wait.")
                        .font(.caption).foregroundStyle(palette.inkSoft)
                }
                .frame(maxWidth: 680)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .frame(maxWidth: .infinity).background(.bar)
            }
        }
        .task { await permissions.refresh() }
        .onChange(of: phase) { _, phase in
            if phase == .active { Task { await permissions.refresh() } }
            if phase == .background { request?.cancel(); permissions.stop() }
        }
        .onDisappear { request?.cancel(); permissions.stop() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                PixelCat(happy: true, fill: palette.surface2, line: palette.ink)
                    .frame(width: 56, height: 56)
                Text("A little setup. A lot of help.")
                    .font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
            }
            Text("Let’s get Nekko ready")
                .font(.largeTitle.weight(.bold)).foregroundStyle(palette.ink)
                .accessibilityAddTraits(.isHeader)
            Text("You’re in control of what Nekko can use on this device. Tap each item to review access, one at a time.")
                .foregroundStyle(palette.inkSoft)
        }
    }

    private func group(_ title: LocalizedStringKey, subtitle: LocalizedStringKey, items: [PermissionChecklist.Item]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline).foregroundStyle(palette.ink).accessibilityAddTraits(.isHeader)
                Text(subtitle).font(.subheadline).foregroundStyle(palette.inkSoft)
            }
            ForEach(items) { item in row(item) }
        }
    }

    private func row(_ item: PermissionChecklist.Item) -> some View {
        let state = permissions.status(item)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: item.icon).font(.title3).foregroundStyle(palette.accent)
                    .frame(width: 28, height: 28).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title).font(.headline).foregroundStyle(palette.ink)
                    Text(item.detail).font(.subheadline).foregroundStyle(palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack { status(state); Spacer(minLength: 12); action(item, state: state) }
                VStack(alignment: .leading, spacing: 8) { status(state); action(item, state: state) }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.line))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("permissions.row.\(item.rawValue)")
    }

    private func status(_ state: PermissionChecklist.Access) -> some View {
        Label(state.label, systemImage: state.checked ? "checkmark.circle.fill" : "circle.dashed")
            .font(.caption.weight(.semibold))
            .foregroundStyle(state.checked ? palette.success : palette.inkSoft)
    }

    private func action(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> some View {
        Button {
            if state.checked || state == .denied || item == .liveActivities {
                PermissionChecklist.openSettings()
            } else {
                request = Task {
                    await permissions.request(item)
                    await app.permissionChecklistChanged()
                }
            }
        } label: {
            HStack(spacing: 8) {
                if permissions.busy == item { ProgressView().controlSize(.small) }
                Text(buttonTitle(item, state: state))
            }
            .frame(minHeight: 32)
        }
        .buttonStyle(.bordered)
        .disabled(!state.canRequest || permissions.busy != nil)
        .accessibilityLabel("\(buttonTitle(item, state: state)): \(item.title)")
        .accessibilityIdentifier("permissions.action.\(item.rawValue)")
    }

    private func buttonTitle(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> String {
        if permissions.busy == item { return String(localized: "Checking…") }
        if !state.canRequest { return state.label }
        if state.checked || state == .denied || item == .liveActivities { return String(localized: "Settings") }
        if item == .network { return String(localized: "Look on this network") }
        if item == .authentication { return String(localized: "Check authentication") }
        return String(localized: "Allow")
    }
}
