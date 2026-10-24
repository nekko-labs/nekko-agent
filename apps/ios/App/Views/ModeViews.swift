import NekkoKit
import NekkoProtocol
import SwiftUI

// MARK: - Simple and Expert

/// Simple or Expert, at the top left of a chat (2026-10-24), like the layout
/// toggle at the top left of the desktop's Agent board. Simple keeps the
/// chat's model, effort and context; Expert adds the computer's hardware and
/// the models its Model Server holds.
struct ModeToggle: View {
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var prefs = prefs
        Menu {
            Picker("Mode", selection: $prefs.expertMode) {
                Label("Simple", systemImage: Self.icon(expert: false)).tag(false)
                Label("Expert", systemImage: Self.icon(expert: true)).tag(true)
            }
        } label: {
            Label(prefs.expertMode ? "Expert" : "Simple", systemImage: Self.icon(expert: prefs.expertMode))
                .labelStyle(.titleAndIcon)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(prefs.expertMode ? palette.accent : palette.ink)
        }
        .accessibilityLabel("Mode")
        .accessibilityValue(prefs.expertMode ? "Expert" : "Simple")
        .accessibilityHint("Expert adds your computer’s hardware and loaded models")
        .accessibilityIdentifier("chat.mode")
    }

    static func icon(expert: Bool) -> String {
        expert ? "gauge.with.dots.needle.100percent" : "gauge.with.dots.needle.33percent"
    }
}

// MARK: - Gauges

/// A gauge's arc: `fraction` of a 240° sweep, open at the bottom.
struct GaugeArc: Shape {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let r = min(rect.width, rect.height) / 2
        var p = Path()
        p.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: r, startAngle: .degrees(150),
                 endAngle: .degrees(150 + 240 * max(0, min(1, fraction))), clockwise: false)
        return p
    }
}

/// A gauge's needle, pointing at `fraction` of the sweep.
struct GaugeNeedle: Shape {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2 * 0.72
        let a = Angle.degrees(150 + 240 * max(0, min(1, fraction))).radians
        var p = Path()
        p.move(to: c)
        p.addLine(to: CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a)))
        return p
    }
}

extension Palette {
    func tone(_ t: MonitorTone) -> Color {
        switch t {
        case .ok: return accent
        case .warn: return warning
        case .hot: return danger
        }
    }
}

/// One reading as a dial: the arc fills with the load, the value in the middle.
struct RingGauge: View {
    /// 0...1; nil when the computer has no reading.
    let fraction: Double?
    let value: String
    let label: String
    /// A second line under the value, e.g. a temperature.
    var caption: String?
    var captionTone: MonitorTone = .ok
    var size: CGFloat = 64
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                GaugeArc(fraction: 1).stroke(palette.surface2, style: StrokeStyle(lineWidth: size * 0.1, lineCap: .round))
                if let fraction {
                    GaugeArc(fraction: fraction)
                        .stroke(palette.tone(MonitorTone.of(fraction)), style: StrokeStyle(lineWidth: size * 0.1, lineCap: .round))
                        .animation(.easeOut(duration: 0.4), value: fraction)
                }
                VStack(spacing: 0) {
                    Text(value).font(.system(size: size * 0.22, weight: .semibold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(fraction == nil ? palette.inkFaint : palette.ink)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if let caption {
                        Text(caption).font(.system(size: size * 0.15, weight: .medium)).monospacedDigit()
                            .foregroundStyle(captionTone == .ok ? palette.inkSoft : palette.tone(captionTone))
                    }
                }
                .padding(.horizontal, size * 0.14)
            }
            .frame(width: size, height: size)
            Text(label).font(.caption2).foregroundStyle(palette.inkSoft).lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: size + 24)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(caption.map { "\(value), \($0)" } ?? value)
    }
}

/// How hard the model works, as a dial: one notch per level the model takes.
/// No level (the computer's own setting) leaves the arc empty, the needle centred.
struct EffortGauge: View {
    let level: Int?
    let count: Int
    var size: CGFloat = 24
    @Environment(\.palette) private var palette

    var body: some View {
        let f = level.map { Double($0 + 1) / Double(max(1, count)) }
        let width = max(2, size * 0.12)
        ZStack {
            GaugeArc(fraction: 1).stroke(palette.surface2, style: StrokeStyle(lineWidth: width, lineCap: .round))
            if let f {
                GaugeArc(fraction: f).stroke(palette.accent, style: StrokeStyle(lineWidth: width, lineCap: .round))
            }
            GaugeNeedle(fraction: f ?? 0.5)
                .stroke(f == nil ? palette.inkFaint : palette.ink, style: StrokeStyle(lineWidth: max(1.5, size * 0.07), lineCap: .round))
            Circle().fill(f == nil ? palette.inkFaint : palette.ink).frame(width: size * 0.16, height: size * 0.16)
        }
        .frame(width: size, height: size)
        .animation(.snappy, value: level)
        .accessibilityHidden(true)
    }
}

func effortLabel(_ e: Effort) -> String {
    switch e {
    case .low: return String(localized: "Low")
    case .medium: return String(localized: "Medium")
    case .normal: return String(localized: "Normal")
    case .high: return String(localized: "High")
    case .xhigh: return String(localized: "Extra high")
    case .max: return String(localized: "Max")
    }
}

// MARK: - Model and effort

/// The composer's one control for the chat's model and effort: an effort dial
/// and the model's name. Opens the sheet that changes both.
struct ModelEffortButton: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        let levels = Effort.levels(for: chat.modelId ?? "")
        let level = chat.effort.flatMap { levels.firstIndex(of: $0) }
        let name = chat.modelName ?? String(localized: "Choose a model")
        Button { open = true } label: {
            HStack(spacing: 6) {
                EffortGauge(level: level, count: levels.count, size: 22)
                Text(name).font(.footnote.weight(.medium)).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
            }
            .padding(.leading, 4).padding(.trailing, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(chat.savedAt != nil)
        .accessibilityLabel("Model and effort")
        .accessibilityValue("\(name), \(chat.effort.map(effortLabel) ?? String(localized: "Computer default"))")
        .accessibilityIdentifier("chat.modelEffort")
        .sheet(isPresented: $open) { ModelEffortSheet(chat: chat) }
    }
}

/// The chat's model, and its effort on a dial with one stop per level.
struct ModelEffortSheet: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var picking = false
    @State private var error: String?
    @State private var busy: Effort?

    var body: some View {
        let levels = Effort.levels(for: chat.modelId ?? "")
        let level = chat.effort.flatMap { levels.firstIndex(of: $0) }
        let computer = store.active?.name ?? String(localized: "your computer")
        NavigationStack {
            List {
                Section("Model") {
                    Button { picking = true } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(chat.modelName ?? String(localized: "Choose a model")).foregroundStyle(palette.ink)
                                if let id = chat.modelId, id != chat.modelName { Text(id).font(.caption2).foregroundStyle(palette.inkFaint) }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.inkFaint)
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("modelEffort.model")
                }
                Section {
                    VStack(spacing: 12) {
                        EffortGauge(level: level, count: levels.count, size: 112)
                        Text(chat.effort.map(effortLabel) ?? String(localized: "Computer default")).font(.headline).foregroundStyle(palette.ink)
                        HStack(spacing: 6) {
                            ForEach(Array(levels.enumerated()), id: \.element) { i, e in
                                Button { set(e) } label: {
                                    Group {
                                        if busy == e { ProgressView().controlSize(.small) } else { Text(effortLabel(e)) }
                                    }
                                    .font(.footnote.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(i == level ? palette.accent : palette.surface2, in: Capsule())
                                    .foregroundStyle(i == level ? palette.onAccent : palette.ink)
                                    .contentShape(Capsule())
                                }
                                .buttonStyle(.plain)
                                .disabled(busy != nil)
                                .accessibilityAddTraits(i == level ? .isSelected : [])
                                .accessibilityIdentifier("modelEffort.\(e.rawValue)")
                            }
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                } header: {
                    Text("Effort")
                } footer: {
                    Text(chat.effort == nil
                         ? "Following \(computer)’s effort setting. Higher effort thinks longer and spends more tokens."
                         : "Higher effort thinks longer and spends more tokens.")
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger) }
                }
            }
            .navigationTitle("Model and effort")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $picking) {
                ModelPicker(selected: (chat.providerId, chat.modelId)) { p, m in
                    Task {
                        do { try await chat.setOptions(providerId: p, modelId: m) } catch { self.error = error.localizedDescription }
                    }
                }
            }
            .task { await store.loadAllModels() }
        }
        .presentationDetents([.medium, .large])
    }

    private func set(_ e: Effort) {
        guard e != chat.effort else { return }
        busy = e
        error = nil
        Task {
            do { try await chat.setOptions(effort: e) } catch { self.error = error.localizedDescription }
            busy = nil
        }
    }
}

// MARK: - Context

/// The chat's context window in the composer, in Simple and Expert alike: a
/// ring that fills as the window does, and the count. Tap for what fills it.
struct ContextGauge: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        let used = chat.contextTokens
        let window = chat.context?.contextWindow
        let fraction = used.flatMap { u in window.map { min(1, Double(u) / Double(max(1, $0))) } }
        let tone = ContextUsage(usedTokens: used ?? 0, contextWindow: window).tone
        let text = used.map { u in window.map { "\(MonitorFormat.tokens(u)) / \(MonitorFormat.tokens($0))" } ?? MonitorFormat.tokens(u) } ?? "–"
        Button { open = true } label: {
            HStack(spacing: 5) {
                ZStack {
                    Circle().stroke(palette.surface2, lineWidth: 3)
                    if let fraction {
                        Circle().trim(from: 0, to: fraction)
                            .stroke(palette.tone(tone), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .animation(.easeOut(duration: 0.3), value: fraction)
                    }
                }
                .frame(width: 16, height: 16)
                Text(text).font(.caption.monospacedDigit()).foregroundStyle(tone == .ok ? palette.inkSoft : palette.tone(tone))
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(chat.context == nil)
        .accessibilityLabel("Context window")
        .accessibilityValue(contextDescription(used: used, window: window))
        .accessibilityIdentifier("chat.context")
        .popover(isPresented: $open) {
            ContextBreakdown(chat: chat).frame(minWidth: 280).presentationCompactAdaptation(.popover)
        }
    }
}

func contextDescription(used: Int64?, window: Int64?) -> String {
    guard let used else { return String(localized: "Not known yet") }
    guard let window else { return String(localized: "\(MonitorFormat.tokens(used)) tokens in use") }
    return String(localized: "\(MonitorFormat.tokens(used)) of \(MonitorFormat.tokens(window)) tokens in use")
}

func contextSourceName(_ s: String) -> String {
    switch s {
    case "system": return String(localized: "System prompt")
    case "conversation": return String(localized: "Conversation")
    case "attached-file": return String(localized: "Attached files")
    case "guideline": return String(localized: "Guidelines")
    case "memory": return String(localized: "Memory")
    case "connector": return String(localized: "Connectors")
    case "index-snippet": return String(localized: "Code index")
    case "skill": return String(localized: "Skill")
    default: return s
    }
}

/// Where the chat's tokens go, biggest first, and what is left.
struct ContextBreakdown: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Context window").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
            if let c = chat.context {
                let used = chat.contextTokens ?? c.usedTokens
                Text(contextDescription(used: used, window: c.contextWindow)).font(.footnote).foregroundStyle(palette.inkSoft)
                ForEach(c.sources) { s in
                    HStack {
                        Text(contextSourceName(s.source)).foregroundStyle(palette.ink)
                        Spacer()
                        Text(MonitorFormat.tokens(s.tokens)).monospacedDigit().foregroundStyle(palette.inkSoft)
                        if let w = c.contextWindow {
                            Text("\(Int((Double(s.tokens) / Double(w) * 100).rounded()))%").monospacedDigit().foregroundStyle(palette.inkFaint)
                                .frame(minWidth: 36, alignment: .trailing)
                        }
                    }
                    .font(.footnote)
                }
                if used > c.usedTokens {
                    HStack {
                        Text("This reply so far").foregroundStyle(palette.ink)
                        Spacer()
                        Text(MonitorFormat.tokens(used - c.usedTokens)).monospacedDigit().foregroundStyle(palette.inkSoft)
                    }
                    .font(.footnote)
                }
                if let w = c.contextWindow {
                    Divider()
                    HStack {
                        Text("Free").foregroundStyle(palette.ink)
                        Spacer()
                        Text(MonitorFormat.tokens(max(0, w - used))).monospacedDigit().foregroundStyle(palette.inkSoft)
                    }
                    .font(.footnote.weight(.semibold))
                }
            } else {
                Text("Not known yet").font(.footnote).foregroundStyle(palette.inkSoft)
            }
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Expert monitor

/// Hardware readings as dials, in the desktop Hardware monitor's order: CPU,
/// memory, each GPU, then GPU memory.
struct HardwareDials: View {
    let monitor: MonitorModel
    var size: CGFloat = 64

    var body: some View {
        ForEach(Self.rows(monitor), id: \.label) { row in
            RingGauge(fraction: row.fraction, value: row.value, label: row.label, caption: row.temp.map { "\(Int($0.rounded()))°C" },
                      captionTone: row.temp.map(MonitorTone.temperature) ?? .ok, size: size)
        }
    }

    struct Row {
        let label: String
        let fraction: Double?
        let value: String
        let temp: Double?
    }

    static func rows(_ m: MonitorModel) -> [Row] {
        let pct = { (f: Double?) in f.map { "\(Int(($0 * 100).rounded()))%" } ?? "–" }
        var rows = [
            Row(label: String(localized: "CPU"), fraction: m.system.map { min(1, max(0, $0.cpuPct / 100)) },
                value: m.system.map { "\(Int($0.cpuPct.rounded()))%" } ?? "–", temp: m.system?.cpuC),
            Row(label: String(localized: "Memory"), fraction: m.system?.memFraction, value: pct(m.system?.memFraction), temp: m.system?.memoryC),
        ]
        let devices = m.gpu?.devices ?? []
        for d in devices {
            let f = d.utilizationPct.map { min(1, max(0, $0 / 100)) }
            let name = devices.count == 1 ? String(localized: "GPU") : String(localized: "GPU \(d.index + 1)")
            // The board's sensor fills in for the only GPU, as on the desktop.
            rows.append(Row(label: name, fraction: f, value: pct(f), temp: d.temperatureC ?? (devices.count == 1 ? m.system?.gpuC : nil)))
        }
        if let g = m.gpu, g.totalMB > 0 {
            rows.append(Row(label: g.unified ? String(localized: "GPU memory") : String(localized: "VRAM"), fraction: g.memFraction, value: pct(g.memFraction), temp: nil))
        }
        return rows
    }
}

/// Expert mode's panel under the chat's title: the computer's hardware as
/// small dials and how many models it holds. Tap for the whole monitor.
struct MonitorPanel: View {
    let monitor: MonitorModel
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            HStack(alignment: .top, spacing: 10) {
                if monitor.system == nil && monitor.gpu == nil {
                    Label(monitor.error ?? String(localized: "Reading \(store.active?.name ?? "your computer")…"), systemImage: "gauge.with.dots.needle.33percent")
                        .font(.footnote).foregroundStyle(palette.inkSoft).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) { HardwareDials(monitor: monitor, size: 40) }
                    }
                    .allowsHitTesting(false)
                }
                VStack(spacing: 2) {
                    Image(systemName: "cube.fill").font(.body).foregroundStyle(palette.accent)
                    Text("\(monitor.engine?.resident.count ?? 0)").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(palette.ink)
                    Text("Loaded").font(.caption2).foregroundStyle(palette.inkSoft)
                }
                .frame(minWidth: 44)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.line))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Monitor")
        .accessibilityValue(HardwareDials.rows(monitor).map { "\($0.label) \($0.value)" }.joined(separator: ", ")
            + ", " + String(localized: "\(monitor.engine?.resident.count ?? 0) models loaded"))
        .accessibilityHint("Shows the hardware and loaded models")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("chat.monitor")
        .sheet(isPresented: $open) { MonitorSheet(monitor: monitor, chat: chat) }
    }
}

/// The whole monitor: hardware dials, the models the Model Server holds (with
/// Unload, where they run, their context and memory), and this chat's context.
struct MonitorSheet: View {
    let monitor: MonitorModel
    let chat: ChatModel?
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var notice: (text: String, ok: Bool)?

    var body: some View {
        let computer = store.active?.name ?? String(localized: "your computer")
        NavigationStack {
            List {
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 12)], spacing: 16) {
                        HardwareDials(monitor: monitor, size: 72)
                    }
                    .padding(.vertical, 8)
                } header: {
                    Text("Hardware")
                } footer: {
                    if let s = monitor.system, s.memTotalMB > 0 {
                        Text(s.cpuCores > 0 ? "\(s.cpuCores) cores. Memory: \(MonitorFormat.memory(usedMB: s.memUsedMB, totalMB: s.memTotalMB))."
                                            : "Memory: \(MonitorFormat.memory(usedMB: s.memUsedMB, totalMB: s.memTotalMB)).")
                    }
                }
                Section {
                    models
                } header: {
                    Text("Loaded models")
                } footer: {
                    Text("Unloading frees the model’s memory on \(computer). The next reply that uses it loads it again.")
                }
                if let chat, chat.context != nil {
                    Section("This chat") { ContextBreakdown(chat: chat).listRowInsets(EdgeInsets()) }
                }
                if let error = monitor.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.warning) }
                }
            }
            .navigationTitle("Monitor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await monitor.refresh() }
            .safeAreaInset(edge: .bottom) {
                if let notice {
                    Label(notice.text, systemImage: notice.ok ? "checkmark.circle" : "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(notice.ok ? palette.ink : palette.danger)
                        .padding(12).frame(maxWidth: .infinity)
                        .background(.bar)
                }
            }
        }
        .accessibilityIdentifier("monitor.sheet")
    }

    @ViewBuilder private var models: some View {
        if let e = monitor.engine {
            if !e.installed {
                Text("No Model Server is installed on \(store.active?.name ?? "your computer").").font(.footnote).foregroundStyle(palette.inkSoft)
            } else if !e.running {
                Text("The Model Server is stopped.").font(.footnote).foregroundStyle(palette.inkSoft)
            } else if e.resident.isEmpty && e.loading.isEmpty {
                Text("No local model is loaded.").font(.footnote).foregroundStyle(palette.inkSoft)
            }
            ForEach(e.resident) { r in ResidentRow(model: r, name: monitor.name(r.id), budget: e.budgetBytes, unloading: monitor.unloading == r.id) { unload(r) } }
            ForEach(e.loading) { l in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(monitor.name(l.id)).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                        Spacer()
                        Text(l.phase == "loading" ? "Loading…" : "Queued").font(.caption).foregroundStyle(palette.inkSoft)
                    }
                    if let p = l.progress { ProgressView(value: p) } else { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
                }
                .padding(.vertical, 4)
            }
            if let budget = e.budgetBytes, budget > 0 {
                let used = e.resident.reduce(Int64(0)) { $0 + ($1.bytes ?? 0) }
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(memoryKindName(e.memoryKind)).font(.footnote).foregroundStyle(palette.ink)
                        Spacer()
                        Text("\(MonitorFormat.bytes(used)) of \(MonitorFormat.bytes(budget))").font(.footnote.monospacedDigit()).foregroundStyle(palette.inkSoft)
                    }
                    ProgressView(value: e.memFraction ?? 0).tint(palette.tone(MonitorTone.of(e.memFraction)))
                }
                .accessibilityElement(children: .combine)
            }
        } else if monitor.loaded {
            Text("\(store.active?.name ?? "This computer") didn’t send its Model Server.").font(.footnote).foregroundStyle(palette.inkSoft)
        } else {
            ProgressView()
        }
    }

    private func memoryKindName(_ kind: String?) -> String {
        switch kind {
        case "unified": return String(localized: "Memory for models (shared)")
        case "ram": return String(localized: "Memory for models (RAM)")
        default: return String(localized: "Memory for models (VRAM)")
        }
    }

    private func unload(_ r: EngineStatus.Resident) {
        notice = nil
        Task {
            do {
                let message = try await monitor.unload(r.id)
                notice = (message, true)
                Haptics.tap()
            } catch {
                notice = (store.readable(error).localizedDescription, false)
            }
        }
    }
}

/// One model the Model Server holds: where it runs, its context and memory, and Unload.
struct ResidentRow: View {
    let model: EngineStatus.Resident
    let name: String
    let budget: Int64?
    let unloading: Bool
    var unload: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                    Text(details).font(.caption).foregroundStyle(model.split ? palette.warning : palette.inkSoft)
                }
                Spacer()
                Button(action: unload) {
                    Group {
                        if unloading { ProgressView().controlSize(.small) } else { Text("Unload") }
                    }
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12).frame(minWidth: 72, minHeight: 36)
                    .background(palette.surface2, in: Capsule())
                    .foregroundStyle(palette.danger)
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(unloading)
                .accessibilityLabel("Unload \(name)")
                .accessibilityIdentifier("monitor.unload")
            }
            if let budget, budget > 0, let bytes = model.bytes {
                ProgressView(value: min(1, Double(bytes) / Double(budget))).tint(palette.accent)
                    .accessibilityLabel("Share of memory for models")
            }
        }
        .padding(.vertical, 4)
    }

    /// "GPU · 32k context · 4.7 GB", as the desktop's Local models monitor writes it.
    private var details: String {
        var parts: [String] = []
        switch model.loadedOn {
        case "gpu": parts.append(String(localized: "GPU"))
        case "gpu+cpu":
            if let g = model.gpuLayers, let t = model.totalLayers { parts.append(String(localized: "GPU + CPU (\(g)/\(t) layers)")) } else { parts.append(String(localized: "GPU + CPU")) }
        case "cpu": parts.append(String(localized: "CPU only"))
        default: break
        }
        if let c = model.contextLength { parts.append(String(localized: "\(MonitorFormat.tokens(c)) context")) }
        if let b = model.bytes { parts.append(MonitorFormat.bytes(b)) }
        return parts.joined(separator: " · ")
    }
}
