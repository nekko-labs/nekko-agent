import NekkoKit
import SwiftUI

/// Insert directly in ComputerDetailView's List. Uses its existing store and the
/// app's native step-up presenter, with no settings writes or shell fallback.
struct ComputerServiceSection: View {
    let computerId: String
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ServiceManagementModel?

    private var connectionKey: String { "\(computerId):\(store.activeId ?? ""):\(store.conn):\(scenePhase)" }

    var body: some View {
        Section {
            if let model, model.computerId == computerId {
                serviceRows(model)
            } else {
                ProgressView("Loading service status")
            }
        } header: {
            SectionTitle("Nekko Agent service")
        } footer: {
            Text("These controls manage Nekko Agent, not the operating system. A restart or install may interrupt chats. An accepted request is not proof that it finished.")
                .foregroundStyle(palette.inkSoft)
        }
        .task(id: connectionKey) {
            guard scenePhase == .active else { model?.cancelConfirmation(); return }
            if model?.computerId != computerId { model = ServiceManagementModel(computerId: computerId, store: store) }
            guard let model else { return }
            await model.connectionChanged()
            // Only the visible section polls, and only a busy updater sends reads.
            // No polling or reconnect path sends a mutation.
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                if model.shouldPoll { await model.pollUpdate() }
            }
        }
        .confirmationDialog(model?.pendingConfirmation?.title ?? "Confirm service action",
                            isPresented: Binding(get: { model?.pendingConfirmation != nil },
                                                 set: { if !$0 { model?.cancelConfirmation() } }),
                            titleVisibility: .visible) {
            if let action = model?.pendingConfirmation {
                Button(action.title, role: .destructive) { model?.confirm() }
                    .accessibilityIdentifier("service.confirm")
                Button("Cancel", role: .cancel) { model?.cancelConfirmation() }
            }
        } message: {
            Text(model?.pendingConfirmation?.confirmation ?? "")
        }
    }

    @ViewBuilder private func serviceRows(_ m: ServiceManagementModel) -> some View {
        if let version = m.knownVersion {
            LabeledContent("Known version", value: version)
                .accessibilityIdentifier("service.version")
        }
        if !m.online {
            Text("Connect to this computer to see its service status and manage updates.")
                .font(.footnote).foregroundStyle(palette.inkSoft)
                .accessibilityIdentifier("service.offline")
        } else {
            if m.loading { ProgressView("Reading service status") }
            if let action = m.inFlight {
                ProgressView(action.title)
                    .accessibilityIdentifier("service.inFlight")
            }
            if m.status != nil {
                LabeledContent("Service", value: "Running")
                    .accessibilityIdentifier("service.status")
            }
            if let status = m.status, !status.manageServiceFromPhone {
                Text(m.optInInstructions).font(.footnote).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("service.optInInstructions")
            }
            if let update = m.update {
                LabeledContent("Updater", value: updateLabel(update))
                    .accessibilityIdentifier("service.updateState")
                if let version = update.version { LabeledContent("Update version", value: version) }
                if update.state == .downloading, let percent = update.percent {
                    ProgressView(value: percent, total: 100) {
                        Text("Downloaded \(Int(percent))%")
                    }
                    .accessibilityIdentifier("service.downloadProgress")
                }
            }
            Button { Task { await m.refresh() } } label: {
                Label("Refresh service status", systemImage: "arrow.clockwise")
            }
            .disabled(m.loading || m.inFlight != nil)
            .accessibilityIdentifier("service.refresh")
            if m.status?.manageServiceFromPhone == true {
                ForEach([ServiceAction.updateCheck, .updateDownload, .updateInstall, .restart]) { action in
                    actionRow(action, m)
                }
                if m.status?.capabilities[.updateState]?.supported == false {
                    Text(ServiceManagementModel.capabilityReason(m.status?.capabilities[.updateState]?.reason))
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }
            }
        }
        if let notice = m.notice {
            Label(notice, systemImage: "info.circle").font(.footnote).foregroundStyle(palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("service.notice")
        }
        if let problem = m.problem {
            Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("service.problem")
        }
    }

    private func actionRow(_ action: ServiceAction, _ model: ServiceManagementModel) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action.title) { Task { await model.request(action) } }
                .disabled(model.disabledReason(action) != nil)
                .accessibilityIdentifier("service.\(action.rawValue)")
            if let reason = model.disabledReason(action), model.inFlight == nil, !model.loading {
                Text(reason).font(.footnote).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func updateLabel(_ update: ServiceUpdate) -> String {
        switch update.state {
        case .idle: return "Not checked"
        case .checking: return "Checking"
        case .available: return "Update available"
        case .downloading: return "Downloading"
        case .downloaded: return "Ready to install"
        case .none: return "Up to date"
        case .error: return "Update failed"
        }
    }
}
