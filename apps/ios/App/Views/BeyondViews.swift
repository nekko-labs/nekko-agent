import NekkoKit
import NekkoProtocol
import SwiftUI

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
        .appBackground()
        .navigationTitle("Automations")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if model?.loaded != true { ProgressView() } }
        .pawRefreshable { await model?.load() }
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

/// What was used, by where it came from (#1773): each paired computer and this
/// iPhone's own chats, and within each, subscriptions (with their limits) before
/// pay-per-token API use. An All places total on top. Read only.
struct UsageView: View {
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @State private var model: FleetUsageModel?

    var body: some View {
        List {
            if let model { content(model) }
        }
        .listStyle(.insetGrouped)
        .appBackground()
        .navigationTitle("Usage and limits")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if model?.loaded != true { ProgressView() } }
        .pawRefreshable { await model?.load() }
        .task {
            if model == nil { model = FleetUsageModel(store: store, phone: phone) }
            await model?.load()
        }
        .accessibilityIdentifier("usage.view")
    }

    @ViewBuilder private func content(_ model: FleetUsageModel) -> some View {
        if model.loaded && model.places.isEmpty {
            Text("No usage recorded yet.").font(.subheadline).foregroundStyle(palette.inkSoft)
        }
        if model.places.count > 1 {
            let t = model.total
            Section {
                LabeledContent("Tokens", value: Self.tokens(t.tokens))
                LabeledContent("On a subscription", value: Self.tokens(t.subscriptionTokens))
                LabeledContent("API", value: Self.tokens(t.apiTokens))
                LabeledContent("Estimated API spend", value: Self.money(t.apiCost))
                if t.offline > 0 {
                    Text("Some places are offline: their last numbers are counted.").font(.footnote).foregroundStyle(palette.inkSoft)
                }
            } header: { SectionTitle(String(localized: "All places")) }
                .accessibilityIdentifier("usage.total")
        }
        ForEach(model.places) { place in
            UsagePlaceSection(usage: place, place: chatPlace(place))
        }
    }

    private func chatPlace(_ p: UsagePlace) -> ChatPlace {
        if p.kind == .phone { return ChatPlace.phonePlace }
        return ChatPlace.of(p.id, store: store) ?? ChatPlace(id: p.id, name: p.name, color: Int(ComputerColors.computer(at: 0)))
    }

    static func tokens(_ n: Int64) -> String { n.formatted(.number.notation(.compactName)) }
    static func money(_ x: Double) -> String { x.formatted(.currency(code: "USD")) }
}

/// One place's usage: its subscriptions and their limits, then its API use, then its recent days.
private struct UsagePlaceSection: View {
    let usage: UsagePlace
    let place: ChatPlace
    @Environment(\.palette) private var palette
    @State private var showDays = false

    var body: some View {
        Section {
            status
            if !usage.plans.isEmpty || !usage.subscriptionModels.isEmpty {
                Subheading(text: String(localized: "Subscriptions"))
                ForEach(usage.plans) { plan in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(plan.title).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                        ForEach(plan.limits.windows) { w in LimitBar(window: w) }
                        if plan.limits.windows.isEmpty {
                            Text("No limits reported.").font(.footnote).foregroundStyle(palette.inkSoft)
                        }
                    }
                    .padding(.vertical, 2)
                }
                ForEach(usage.subscriptionModels) { m in
                    LabeledContent(m.model, value: UsageView.tokens(m.tokens))
                }
            }
            if !usage.apiGroups.isEmpty || (usage.apiCost ?? 0) > 0 {
                Subheading(text: String(localized: "API"))
                ForEach(usage.apiGroups) { group in
                    if let label = group.label {
                        Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    }
                    ForEach(group.models) { m in
                        LabeledContent(m.model, value: usage.priced ? "\(UsageView.tokens(m.tokens)) · \(UsageView.money(m.cost))" : UsageView.tokens(m.tokens))
                    }
                }
                if let cost = usage.apiCost {
                    LabeledContent("Estimated API spend", value: UsageView.money(cost))
                }
            }
            if let days = usage.summary?.days, !days.isEmpty {
                DisclosureGroup(isExpanded: $showDays) {
                    ForEach(days.reversed()) { d in
                        LabeledContent(d.date, value: usage.priced ? "\(UsageView.tokens(d.tokens)) · \(UsageView.money(d.cost))" : UsageView.tokens(d.tokens))
                    }
                } label: {
                    Text("Recent days").font(.subheadline).foregroundStyle(palette.ink)
                }
            }
            if usage.kind == .phone && usage.summary != nil {
                Text("Counted from each provider’s replies, in tokens only. It stays on \(place.name).")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
            }
        } header: {
            HStack(spacing: 6) {
                PlaceMark(place: place, size: 14)
                Text(place.name).foregroundStyle(palette.inkSoft).lineLimit(1)
                Spacer(minLength: 8)
                if !usage.online {
                    Text("Offline").font(.caption.weight(.semibold)).foregroundStyle(palette.warning).textCase(nil)
                }
            }
            .accessibilityElement(children: .combine)
        }
        .accessibilityIdentifier("usage.place")
    }

    @ViewBuilder private var status: some View {
        if let e = usage.error {
            Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
        }
        if !usage.online && usage.isEmpty {
            Text("Offline. Its usage shows here when it reconnects.").font(.footnote).foregroundStyle(palette.inkSoft)
        } else if !usage.online {
            Text("Offline. These are the last numbers it gave.").font(.footnote).foregroundStyle(palette.inkSoft)
        } else if usage.isEmpty {
            Text("No usage recorded yet.").font(.footnote).foregroundStyle(palette.inkSoft)
        }
    }
}

/// A group's name inside a place's section: Subscriptions or API.
private struct Subheading: View {
    let text: String
    @Environment(\.palette) private var palette
    var body: some View {
        Text(text).font(.footnote.weight(.bold)).foregroundStyle(palette.accent)
            .accessibilityAddTraits(.isHeader)
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
/// A group heading as the desktop's Agents panel draws them since #940: larger,
/// in the accent, with the active and done counts on the right.
struct GroupHeading: View {
    let text: String
    let count: String
    @Environment(\.palette) private var palette
    init(_ text: String, count: String = "") { self.text = text; self.count = count }
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).font(.subheadline.weight(.bold)).foregroundStyle(palette.accent).textCase(nil)
            Spacer(minLength: 8)
            if !count.isEmpty { Text(count).font(.caption).foregroundStyle(palette.inkFaint).textCase(nil) }
        }
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
    }
}

struct SectionTitle: View {
    let text: String
    @Environment(\.palette) private var palette
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).foregroundStyle(palette.inkSoft) }
}
