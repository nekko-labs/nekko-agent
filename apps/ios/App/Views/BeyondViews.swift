import NekkoKit
import NekkoProtocol
import SwiftUI

/// The chat to pick up again, on top of the list: the most recently active one.
struct ContinueCard: View {
    let summary: SessionSummary
    let activity: Activity?
    var open: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: open) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "arrow.uturn.forward.circle.fill").font(.title2).foregroundStyle(palette.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Continue").font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(2)
                    if let preview {
                        Text(preview).font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if activity == .running {
                    ProgressView().controlSize(.small).accessibilityLabel("Working")
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.inkFaint)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Continue \(title)")
        .accessibilityIdentifier("chats.continue")
    }

    private var title: String { summary.title.trimmingCharacters(in: .whitespaces).isEmpty ? "New chat" : summary.title }

    private var preview: String? {
        let t = (summary.lastReplyText ?? summary.firstUserText ?? "").replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }
}

/// The computer's automations: its tasks and workflows, how each last went,
/// and Run now. Setting them up and changing them happens on the computer.
struct AutomationsView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: AutomationsModel?
    @State private var running: String?
    @State private var failed: String?

    var body: some View {
        List {
            if let model {
                content(model)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.paper)
        .navigationTitle("Automations")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if model?.loaded != true { ProgressView() } }
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = AutomationsModel(store: store) }
            await model?.load()
        }
        .alert("Couldn’t run it", isPresented: Binding(get: { failed != nil }, set: { if !$0 { failed = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failed ?? "") }
    }

    @ViewBuilder private func content(_ model: AutomationsModel) -> some View {
        let computer = store.active?.name ?? "your computer"
        if model.paused {
            Label("Automations are paused on \(computer). Run now still works.", systemImage: "pause.circle")
                .font(.footnote).foregroundStyle(palette.warning).listRowBackground(Color.clear)
        }
        if let e = model.error {
            Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
        } else if model.loaded && model.isEmpty {
            Text("No automations yet. Set them up on \(computer), and run them from here.")
                .font(.subheadline).foregroundStyle(palette.inkSoft).listRowBackground(Color.clear)
        }
        if !model.tasks.isEmpty {
            Section {
                ForEach(model.tasks) { t in
                    AutomationRow(title: t.title, detail: t.cadence, status: taskStatus(t), result: t.lastResult,
                                  lastRun: t.lastRunAt, started: model.started.contains(t.id), busy: running == t.id) {
                        run(t.id) { try await model.run(task: t.id) }
                    }
                }
            } header: { SectionTitle("Tasks") }
        }
        if !model.workflows.isEmpty {
            Section {
                ForEach(model.workflows) { w in
                    AutomationRow(title: w.name, detail: workflowDetail(w), status: workflowStatus(w), result: w.description,
                                  lastRun: w.lastRunAt, started: model.started.contains(w.id), busy: running == w.id) {
                        run(w.id) { try await model.run(workflow: w.id) }
                    }
                }
            } header: { SectionTitle("Workflows") }
        }
    }

    private func run(_ id: String, _ body: @escaping () async throws -> Void) {
        running = id
        Task {
            do {
                try await body()
                Haptics.tap()
            } catch {
                failed = error.localizedDescription
            }
            running = nil
        }
    }

    private func taskStatus(_ t: AutomationTask) -> (String, Color)? {
        if t.failed { return ("Last run failed", palette.danger) }
        if t.paused { return ("Paused", palette.inkSoft) }
        if t.status == "done" { return ("Done", palette.success) }
        return nil
    }

    private func workflowDetail(_ w: AutomationWorkflow) -> String {
        let steps = w.stepCount == 1 ? "1 step" : "\(w.stepCount) steps"
        return [w.category.isEmpty ? nil : w.category, steps, w.enabled ? nil : "Off"].compactMap { $0 }.joined(separator: " · ")
    }

    private func workflowStatus(_ w: AutomationWorkflow) -> (String, Color)? {
        switch w.lastStatus {
        case "success"?: return ("Last run passed", palette.success)
        case "failure"?: return ("Last run failed", palette.danger)
        case "running"?, "queued"?: return ("Running", palette.running)
        case "cancelled"?: return ("Last run cancelled", palette.inkSoft)
        default: return nil
        }
    }
}

private struct AutomationRow: View {
    let title: String
    let detail: String
    let status: (String, Color)?
    let result: String?
    let lastRun: Int64?
    let started: Bool
    let busy: Bool
    var run: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.medium)).foregroundStyle(palette.ink)
                    Text(detail).font(.footnote).foregroundStyle(palette.inkSoft)
                }
                Spacer(minLength: 8)
                Button(action: run) {
                    Group {
                        if busy { ProgressView().controlSize(.small) } else { Text(started ? "Started" : "Run now") }
                    }
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                    .foregroundStyle(started ? palette.inkSoft : palette.accent)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityLabel(started ? "\(title) started" : "Run \(title) now")
                .accessibilityIdentifier("automations.run")
            }
            if let status {
                Text(status.0).font(.caption.weight(.semibold)).foregroundStyle(status.1)
            }
            if let lastRun {
                Text("Last run \(Date(timeIntervalSince1970: Double(lastRun) / 1000), format: .relative(presentation: .named))")
                    .font(.caption).foregroundStyle(palette.inkFaint)
            }
            if let result, !result.isEmpty {
                Text(result).font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(4)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

/// What the computer's providers have used, and each plan's limits. Read only.
struct UsageView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var model: UsageModel?

    var body: some View {
        List {
            if let model { content(model) }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.paper)
        .navigationTitle("Usage and limits")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if model?.loaded != true { ProgressView() } }
        .refreshable { await model?.load() }
        .task {
            if model == nil { model = UsageModel(store: store) }
            await model?.load()
        }
        .accessibilityIdentifier("usage.view")
    }

    @ViewBuilder private func content(_ model: UsageModel) -> some View {
        if let e = model.error {
            Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
        }
        ForEach(model.limited) { item in
            Section {
                ForEach(item.limits.windows) { w in LimitBar(window: w) }
                if item.limits.windows.isEmpty {
                    Text("No limits reported.").font(.footnote).foregroundStyle(palette.inkSoft)
                }
            } header: {
                SectionTitle([item.provider.label, item.limits.planType?.capitalized].compactMap { $0 }.joined(separator: " · "))
            }
        }
        if let s = model.summary {
            Section {
                LabeledContent("Tokens", value: s.totalTokens.formatted(.number.notation(.compactName)))
                LabeledContent("Estimated spend", value: s.totalCost.formatted(.currency(code: "USD")))
            } header: { SectionTitle("All time") }
            if !s.days.isEmpty {
                Section {
                    ForEach(s.days.reversed()) { d in
                        LabeledContent(d.date, value: "\(d.tokens.formatted(.number.notation(.compactName))) · \(d.cost.formatted(.currency(code: "USD")))")
                    }
                } header: { SectionTitle("Recent days") }
            }
            if !s.models.isEmpty {
                Section {
                    ForEach(s.models) { m in
                        LabeledContent(m.model, value: m.subscription ? "\(m.tokens.formatted(.number.notation(.compactName))) · plan"
                                       : "\(m.tokens.formatted(.number.notation(.compactName))) · \(m.cost.formatted(.currency(code: "USD")))")
                    }
                } header: { SectionTitle("By model") }
            }
        } else if model.loaded && model.error == nil {
            Text("No usage recorded yet.").font(.subheadline).foregroundStyle(palette.inkSoft)
        }
    }
}

private struct LimitBar: View {
    let window: ProviderLimits.Window
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(window.label).font(.subheadline).foregroundStyle(palette.ink)
                Spacer()
                Text("\(Int(window.usedPercent.rounded()))% used").font(.subheadline.monospacedDigit()).foregroundStyle(color)
            }
            ProgressView(value: window.usedPercent, total: 100).tint(color)
            if let reset = window.resetAt, reset > 0 {
                Text("Resets \(Date(timeIntervalSince1970: Double(reset) / 1000), format: .relative(presentation: .named))")
                    .font(.caption).foregroundStyle(palette.inkFaint)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        if window.limited { return palette.danger }
        return window.status == "warning" || window.usedPercent >= 80 ? palette.warning : palette.success
    }
}

/// A list section's title in the palette's secondary ink: the system grey only nearly passed contrast on the paper background.
struct SectionTitle: View {
    let text: String
    @Environment(\.palette) private var palette
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).foregroundStyle(palette.inkSoft) }
}
