import NekkoKit
import NekkoProtocol
import SwiftUI

/// The computer's Monitors (FD-5), a phone edition of the desktop's Agent
/// Monitor dock: Hardware, Running, Needs you (Allow / Deny / answer here,
/// through the chat's own calls) and Automations. A pane on a folding phone
/// or iPad, and a row at the bottom of the chat list everywhere else. Reads
/// `monitor:summary` every 10 s while on screen, never in the background.
struct MonitorsView: View {
    /// On screen (a visible pane, or pushed): only then does it read.
    var active: Bool = true
    /// Open a chat (in the other pane, or pushed).
    var open: (String) -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var model: MonitorModel?
    /// The computer `model` reads from.
    @State private var modelFor: String?
    /// Needs you rows being answered.
    @State private var busy: Set<String> = []
    @State private var failed: String?

    private var computer: String { store.active?.name ?? "your computer" }
    private var watching: Bool { active && phase == .active }

    var body: some View {
        List {
            ConnectionBanner().listRowSeparator(.hidden).listRowBackground(Color.clear)
            if let model { sections(model) } else { ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear) }
        }
        .listStyle(.insetGrouped)
        .appBackground()
        .navigationTitle("Monitors")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model?.refresh() }
        // One model per computer: another computer starts from nothing. Runs again on
        // every return to the screen (a chat opened from here and closed), which restarts the reads.
        .task(id: store.activeId) {
            if model == nil || modelFor != store.activeId {
                model?.stop()
                model = MonitorModel(backend: store)
                modelFor = store.activeId
            }
            sync()
        }
        .onChange(of: watching) { _, _ in sync() }
        .onDisappear { model?.stop() }
        .alert("Couldn’t do that", isPresented: Binding(get: { failed != nil }, set: { if !$0 { failed = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(failed ?? "") }
    }

    private func sync() {
        if watching { model?.start() } else { model?.stop() }
    }

    @ViewBuilder private func sections(_ m: MonitorModel) -> some View {
        if m.readOff {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Read is off for this phone", systemImage: "lock").font(.headline).foregroundStyle(palette.ink)
                    Text("Turn it on on \(computer) in Remote access → What phones can do.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("monitors.readOff")
            }
        } else if m.unsupported {
            Section {
                Label("Update Nekko Agent on \(computer) to see its monitors here.", systemImage: "arrow.down.circle")
                    .font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("monitors.unsupported")
            }
        } else {
            if let e = m.error {
                Section {
                    Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                    Button("Try again") { Task { await m.refresh() } }
                }
            }
            if let s = m.summary {
                hardware(s.hardware)
                needsYou(m)
                running(m)
                automations(m)
            } else if !m.loadedOnce || m.loading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
    }

    // MARK: Hardware

    private func hardware(_ h: MonitorSummary.Hardware) -> some View {
        Section("Hardware") {
            meter("CPU", icon: "cpu", load: h.cpu.loadPct.map { $0 / 100 }, value: h.cpu.loadPct.map { "\(Int($0.rounded()))%" },
                  detail: h.cpu.cores.flatMap { $0 > 0 ? String(localized: "\($0) cores") : nil }, temp: h.cpu.tempC)
            meter("Memory", icon: "memorychip", load: h.memory.fraction,
                  value: h.memory.fraction.map { "\(Int(($0 * 100).rounded()))%" },
                  detail: memoryText(h.memory.usedMB, h.memory.totalMB), temp: h.memory.tempC)
            if let g = h.gpu {
                meter("GPU", icon: "square.stack.3d.up", load: g.loadPct.map { $0 / 100 }, value: g.loadPct.map { "\(Int($0.rounded()))%" },
                      detail: g.unified ? String(localized: "Shares the computer’s memory") : memoryText(g.memoryUsedMB, g.memoryTotalMB),
                      temp: g.tempC)
            }
        }
    }

    private func memoryText(_ used: Double?, _ total: Double?) -> String? {
        guard let used, let total, total > 0 else { return nil }
        return MonitorModel.memory(usedMB: used, totalMB: total)
    }

    private func meter(_ name: LocalizedStringKey, icon: String, load: Double?, value: String?, detail: String?, temp: Double?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(name, systemImage: icon).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                Spacer()
                if let temp {
                    Label(MonitorModel.temperature(temp), systemImage: "thermometer.medium").font(.footnote.monospacedDigit())
                        .foregroundStyle(temp >= 85 ? palette.danger : temp >= 75 ? palette.warning : palette.inkSoft)
                }
                if let value { Text(value).font(.subheadline.monospacedDigit()).foregroundStyle(palette.ink) }
            }
            if let load {
                ProgressView(value: min(1, max(0, load))).tint(load >= 0.9 ? palette.danger : load >= 0.7 ? palette.warning : palette.accent)
                    .accessibilityHidden(true)
            }
            if let detail { Text(detail).font(.caption).foregroundStyle(palette.inkSoft) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    // MARK: Needs you

    @ViewBuilder private func needsYou(_ m: MonitorModel) -> some View {
        Section {
            if m.needsYou.isEmpty {
                Text("Nothing needs you.").font(.subheadline).foregroundStyle(palette.inkSoft)
            }
            ForEach(m.needsYou) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Button { open(item.sessionId) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: item.kind == .approval ? "hand.raised" : "questionmark.bubble")
                                .foregroundStyle(palette.warning).accessibilityHidden(true)
                            Text(item.title.isEmpty ? String(localized: "Chat") : item.title)
                                .font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                            Spacer(minLength: 0)
                            if let risk = item.risk { riskChip(risk) }
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the chat")
                    Text(item.kind == .approval ? item.label : (item.count > 1 ? "\(item.label) (+\(item.count - 1))" : item.label))
                        .font(item.kind == .approval ? Font.footnote.monospaced() : Font.footnote).foregroundStyle(palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                    if item.kind == .approval {
                        HStack {
                            Button(role: .destructive) { decide(m, item, false) } label: {
                                Text("Deny").frame(maxWidth: .infinity, minHeight: 36).foregroundStyle(palette.ink)
                            }
                            .buttonStyle(.bordered).tint(palette.inkSoft)
                            .accessibilityIdentifier("monitors.deny")
                            Button { decide(m, item, true) } label: {
                                Group { if busy.contains(item.id) { ProgressView().tint(palette.onAccent) } else { Text("Allow").font(.body.weight(.semibold)) } }
                                    .foregroundStyle(palette.onAccent)
                                    .frame(maxWidth: .infinity, minHeight: 36)
                                    .background(palette.accent, in: RoundedRectangle(cornerRadius: 10))
                                    .contentShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("monitors.allow")
                        }
                        .disabled(busy.contains(item.id))
                    } else if let q = m.question(item) {
                        QuestionCard(request: q) { answers in try await m.answer(item, answers) }.id(item.id)
                    } else {
                        Button("Answer in the chat") { open(item.sessionId) }.font(.footnote.weight(.semibold))
                    }
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("monitors.needsYou")
            }
        } header: {
            GroupHeading("Needs you", count: m.needsYou.isEmpty ? "" : "\(m.needsYou.count)")
        }
    }

    private func riskChip(_ risk: Severity) -> some View {
        let color = risk == .high ? palette.danger : risk == .medium ? palette.warning : palette.running
        return Text(risk.rawValue.capitalized).font(.caption2.weight(.bold)).padding(.horizontal, 7).padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule()).foregroundStyle(color)
    }

    private func decide(_ m: MonitorModel, _ item: MonitorSummary.NeedsYou, _ allow: Bool) {
        busy.insert(item.id)
        Task {
            do { try await m.approve(item, allow: allow) } catch { failed = "Couldn’t send that: \(error.localizedDescription) Try again." }
            busy.remove(item.id)
        }
    }

    // MARK: Running

    @ViewBuilder private func running(_ m: MonitorModel) -> some View {
        Section {
            if m.running.isEmpty {
                Text("Nothing is running.").font(.subheadline).foregroundStyle(palette.inkSoft)
            }
            ForEach(m.running) { r in
                Button { open(r.id) } label: {
                    HStack(spacing: 10) {
                        stepIcon(r.step)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.title.isEmpty ? String(localized: "Chat") : r.title).font(.subheadline).foregroundStyle(palette.ink).lineLimit(1)
                            Text(stepName(r.step)).font(.caption).foregroundStyle(palette.inkSoft)
                        }
                        Spacer(minLength: 0)
                        if let ms = r.elapsedMs { Text(MonitorModel.elapsed(ms)).font(.footnote.monospacedDigit()).foregroundStyle(palette.inkSoft) }
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the chat")
                .accessibilityIdentifier("monitors.running")
            }
        } header: {
            GroupHeading("Running", count: m.running.isEmpty ? "" : "\(m.running.count)")
        }
    }

    @ViewBuilder private func stepIcon(_ step: MonitorSummary.Step) -> some View {
        switch step {
        case .approval: Image(systemName: "hand.raised.fill").foregroundStyle(palette.warning).accessibilityHidden(true)
        case .question: Image(systemName: "questionmark.bubble.fill").foregroundStyle(palette.warning).accessibilityHidden(true)
        case .working: ProgressView().controlSize(.small).accessibilityHidden(true)
        }
    }

    private func stepName(_ step: MonitorSummary.Step) -> String {
        switch step {
        case .approval: String(localized: "Waiting for an approval")
        case .question: String(localized: "Waiting for an answer")
        case .working: String(localized: "Working")
        }
    }

    // MARK: Automations

    @ViewBuilder private func automations(_ m: MonitorModel) -> some View {
        Section {
            if m.automations.isEmpty {
                Text("No automations scheduled.").font(.subheadline).foregroundStyle(palette.inkSoft)
            }
            ForEach(m.automations) { a in
                HStack(spacing: 10) {
                    Image(systemName: a.kind == .task ? "bolt.badge.clock" : "point.3.connected.trianglepath.dotted")
                        .foregroundStyle(palette.inkSoft).accessibilityHidden(true)
                    Text(a.name.isEmpty ? String(localized: "Automation") : a.name).font(.subheadline).foregroundStyle(palette.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(Date(timeIntervalSince1970: Double(a.nextRunAt) / 1000), format: .relative(presentation: .named))
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
            }
        } header: {
            GroupHeading("Next automations", count: "")
        }
    }
}
