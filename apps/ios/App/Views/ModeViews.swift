import NekkoKit
import NekkoProtocol
import SwiftUI

// MARK: - Simple and Expert

/// Simple or Expert, in the floating pill of a chat and of the chats list: a
/// chat bubble for Simple and code brackets for Expert.
/// Simple hides the controls Settings > Simple mode keeps to Expert.
struct ModeToggle: View {
    /// Stacked, in the pill docked at a side.
    var vertical = false
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    /// The pill is being dragged: the touch that lifted it doesn't also flip the mode.
    @Environment(\.pillMoving) private var moving

    var body: some View {
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 0)) : AnyLayout(HStackLayout(spacing: 0))
        layout {
            segment(expert: false)
            segment(expert: true)
        }
        .background(palette.surface2, in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mode")
        .accessibilityValue(prefs.expertMode ? String(localized: "Expert") : String(localized: "Simple"))
        .accessibilityIdentifier("chat.mode")
    }

    private func segment(expert: Bool) -> some View {
        let on = prefs.expertMode == expert
        return Button { if !moving { prefs.expertMode = expert } } label: {
            Image(systemName: Self.icon(expert: expert))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(on ? palette.onAccent : palette.inkSoft)
                .frame(width: 34, height: 24)
                .background(on ? palette.accent : .clear, in: Capsule())
                .frame(minWidth: 40, minHeight: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expert ? String(localized: "Expert: every control") : String(localized: "Simple: everyday controls"))
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    static func icon(expert: Bool) -> String {
        expert ? "chevron.left.forwardslash.chevron.right" : "bubble.left"
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
        let a = CGFloat(Angle.degrees(150 + 240 * max(0, min(1, fraction))).radians)
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

/// The composer's one control for the chat's model and effort: a small effort
/// dial and the model's name. Opens the dropdown that changes both.
struct ModelEffortButton: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette
    @Environment(Prefs.self) private var prefs
    @State private var open = false

    /// Simple mode may hide either half; a chat with no model yet still offers the picker.
    static func parts(_ prefs: Prefs, _ chat: ChatModel) -> (model: Bool, effort: Bool) {
        (prefs.shows("model") || chat.modelId == nil, prefs.shows("effort"))
    }

    var body: some View {
        let levels = Effort.levels(for: chat.modelId ?? "")
        let level = chat.effort.flatMap { levels.firstIndex(of: $0) }
        let name = chat.modelName ?? String(localized: "Choose a model")
        let parts = Self.parts(prefs, chat)
        Button { open = true } label: {
            HStack(spacing: 6) {
                if parts.effort { EffortGauge(level: level, count: levels.count, size: 16) }
                if parts.model { Text(name).font(.footnote.weight(.medium)).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle) }
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
        .popover(isPresented: $open, arrowEdge: .bottom) {
            ModelEffortPanel(chat: chat).presentationCompactAdaptation(.popover)
        }
    }
}

/// The chat's model, and its effort on a slider with one stop per level: a
/// small dropdown under the composer's control.
struct ModelEffortPanel: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    @State private var picking = false
    @State private var error: String?
    @State private var busy: Effort?

    var body: some View {
        let levels = Effort.levels(for: chat.modelId ?? "")
        let level = chat.effort.flatMap { levels.firstIndex(of: $0) }
        let computer = store.active?.name ?? String(localized: "your computer")
        let parts = ModelEffortButton.parts(prefs, chat)
        VStack(alignment: .leading, spacing: 14) {
            if parts.model {
                Button { picking = true } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Model").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
                            Text(chat.modelName ?? String(localized: "Choose a model")).font(.subheadline.weight(.medium))
                                .foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.inkFaint)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("modelEffort.model")
            }
            if parts.model && parts.effort { Divider() }
            if parts.effort {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Effort").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
                        Spacer()
                        Text(chat.effort.map(effortLabel) ?? String(localized: "Computer default"))
                            .font(.subheadline.weight(.semibold)).foregroundStyle(level == nil ? palette.inkSoft : palette.ink)
                    }
                    EffortSlider(levels: levels, level: level, busy: busy, set: set)
                    Text(chat.effort == nil
                         ? "Following \(computer)’s effort setting. Higher effort thinks longer and spends more tokens."
                         : "Higher effort thinks longer and spends more tokens.")
                        .font(.caption2).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(palette.danger)
            }
        }
        .padding(16)
        .frame(width: 300)
        .sheet(isPresented: $picking) {
            ModelPicker(selected: (chat.providerId, chat.modelId)) { p, m in
                Task {
                    do { try await chat.setOptions(providerId: p, modelId: m) } catch { self.error = error.localizedDescription }
                }
            }
        }
        .task { await store.loadAllModels() }
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

/// Effort as a bar that snaps to the model's levels: the part left of the
/// thumb fills with a gradient that deepens toward it and with each level,
/// with faint speed lines drifting through it. No level (the computer's own
/// setting) leaves the bar empty and the thumb faint in the middle.
struct EffortSlider: View {
    let levels: [Effort]
    let level: Int?
    var busy: Effort?
    var set: (Effort) -> Void
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The stop under a finger mid-drag.
    @State private var dragged: Int?

    var body: some View {
        let count = max(1, levels.count)
        let shown = dragged ?? level
        VStack(spacing: 6) {
            GeometryReader { geo in
                let w = geo.size.width
                let x = Self.x(shown, count: count, width: w)
                let t = shown.map { Double($0 + 1) / Double(count) } ?? 0
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.surface2).frame(height: 8)
                    if shown != nil {
                        ZStack {
                            LinearGradient(colors: [palette.accent.opacity(0.12 + 0.18 * t), palette.accent.opacity(0.45 + 0.55 * t)],
                                           startPoint: .leading, endPoint: .trailing)
                            if !reduceMotion { SpeedLines(intensity: t) }
                        }
                        .frame(width: x, height: 8)
                        .clipShape(Capsule())
                    }
                    ForEach(0..<count, id: \.self) { i in
                        Circle().fill(i <= (shown ?? -1) ? palette.onAccent.opacity(0.7) : palette.inkFaint.opacity(0.5))
                            .frame(width: 3, height: 3)
                            .position(x: Self.x(i, count: count, width: w), y: 12)
                    }
                    Circle().fill(.white)
                        .overlay(Circle().stroke(shown == nil ? palette.line : palette.accent, lineWidth: 2))
                        .overlay { if busy != nil { ProgressView().controlSize(.mini) } }
                        .frame(width: 20, height: 20)
                        .shadow(color: .black.opacity(0.15), radius: 2, y: 1)
                        .position(x: x, y: 12)
                }
                .frame(height: 24)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { v in dragged = Self.index(at: v.location.x, count: count, width: w) }
                    .onEnded { v in
                        let i = Self.index(at: v.location.x, count: count, width: w)
                        dragged = nil
                        if levels.indices.contains(i) { set(levels[i]) }
                    })
                .animation(.snappy(duration: 0.2), value: shown)
            }
            .frame(height: 24)
            .accessibilityElement()
            .accessibilityLabel("Effort")
            .accessibilityValue(level.map { effortLabel(levels[$0]) } ?? String(localized: "Computer default"))
            .accessibilityAdjustableAction { dir in
                let now = level ?? (count - 1) / 2
                let next = dir == .increment ? min(count - 1, now + 1) : max(0, now - 1)
                if levels.indices.contains(next) { set(levels[next]) }
            }
            .accessibilityIdentifier("modelEffort.slider")
            HStack(spacing: 0) {
                ForEach(Array(levels.enumerated()), id: \.element) { i, e in
                    Button { set(e) } label: {
                        Text(effortLabel(e)).font(.caption2.weight(i == level ? .semibold : .regular))
                            .foregroundStyle(i == level ? palette.accent : palette.inkSoft)
                            .lineLimit(1).minimumScaleFactor(0.6)
                            .frame(maxWidth: .infinity, minHeight: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy != nil)
                    .accessibilityAddTraits(i == level ? .isSelected : [])
                    .accessibilityIdentifier("modelEffort.\(e.rawValue)")
                }
            }
        }
    }

    /// Stop `i` sits over the middle of its label's column; nil sits in the middle of the bar.
    static func x(_ i: Int?, count: Int, width: CGFloat) -> CGFloat {
        guard let i else { return width / 2 }
        return (CGFloat(i) + 0.5) * width / CGFloat(max(1, count))
    }

    /// The stop nearest `x`.
    static func index(at x: CGFloat, count: Int, width: CGFloat) -> Int {
        guard width > 0 else { return 0 }
        return min(count - 1, max(0, Int(x / (width / CGFloat(max(1, count))))))
    }
}

/// Thin light streaks drifting left to right, faster and brighter as `intensity` (0...1) rises.
struct SpeedLines: View {
    let intensity: Double

    var body: some View {
        TimelineView(.animation) { tl in
            Canvas { ctx, size in
                let now = tl.date.timeIntervalSinceReferenceDate
                let speed = 18 + 70 * intensity
                for i in 0..<7 {
                    let seed = Double(i) * 0.6180339887
                    let length = 5 + 9 * (seed.truncatingRemainder(dividingBy: 1))
                    let span = size.width + length
                    let x = (now * speed * (0.7 + 0.6 * seed.truncatingRemainder(dividingBy: 1)) + seed * span)
                        .truncatingRemainder(dividingBy: span) - length
                    let y = size.height * (0.25 + 0.5 * (Double(i * 3 % 7) / 6))
                    var p = Path()
                    p.move(to: CGPoint(x: x, y: y))
                    p.addLine(to: CGPoint(x: x + length, y: y))
                    ctx.stroke(p, with: .color(.white.opacity(0.25 + 0.35 * intensity)), style: StrokeStyle(lineWidth: 1, lineCap: .round))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
                            .animation(chat.running ? nil : .easeOut(duration: 0.3), value: fraction)
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
            ContextBreakdown(chat: chat).frame(minWidth: 280).fixedSize(horizontal: false, vertical: true).presentationCompactAdaptation(.popover)
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

// MARK: - Monitor

/// Hardware readings as dials, in the desktop Hardware monitor's order: CPU,
/// memory, each GPU, then GPU memory.
struct HardwareDials: View {
    let monitor: HardwareMonitorModel
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
        /// What the gauge's tooltip adds: the chip, cores, or memory used of the total.
        var detail: String?
    }

    static func rows(_ m: HardwareMonitorModel) -> [Row] {
        let pct = { (f: Double?) in f.map { "\(Int(($0 * 100).rounded()))%" } ?? "–" }
        let cpu = m.system.map { s in
            [s.cpuModel, s.cpuCores > 0 ? String(localized: "\(s.cpuCores) cores") : nil].compactMap { $0 }.joined(separator: " · ")
        }
        var rows = [
            Row(label: String(localized: "CPU"), fraction: m.system.map { min(1, max(0, $0.cpuPct / 100)) },
                value: m.system.map { "\(Int($0.cpuPct.rounded()))%" } ?? "–", temp: m.system?.cpuC, detail: cpu?.isEmpty == false ? cpu : nil),
            Row(label: String(localized: "Memory"), fraction: m.system?.memFraction, value: pct(m.system?.memFraction), temp: m.system?.memoryC,
                detail: m.system.flatMap { $0.memTotalMB > 0 ? MonitorFormat.memory(usedMB: $0.memUsedMB, totalMB: $0.memTotalMB) : nil }),
        ]
        let devices = m.gpu?.devices ?? []
        for d in devices {
            let f = d.utilizationPct.map { min(1, max(0, $0 / 100)) }
            let name = devices.count == 1 ? String(localized: "GPU") : String(localized: "GPU \(d.index + 1)")
            // The board's sensor fills in for the only GPU, as on the desktop.
            rows.append(Row(label: name, fraction: f, value: pct(f), temp: d.temperatureC ?? (devices.count == 1 ? m.system?.gpuC : nil),
                            detail: d.name.isEmpty ? nil : d.name))
        }
        if let g = m.gpu, g.totalMB > 0 {
            rows.append(Row(label: g.unified ? String(localized: "GPU memory") : String(localized: "VRAM"), fraction: g.memFraction, value: pct(g.memFraction), temp: nil,
                            detail: MonitorFormat.memory(usedMB: g.usedMB, totalMB: g.totalMB)))
        }
        return rows
    }
}

/// The colour at the top of `AppBackdrop`, solid, behind the chats list's search row.
struct RowGround: View {
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        palette.accent.opacity(scheme == .dark ? AppBackdrop.darkWash : AppBackdrop.lightWash).background(palette.paper)
    }
}

/// The computer's hardware at a glance: thin rings with their percentages,
/// and how many models the Model Server holds. Tap for the agent's details;
/// hover over a gauge with a pointer for its reading in full.
struct MiniMonitor: View {
    let monitor: HardwareMonitorModel
    var open: () -> Void
    /// Each gauge a ring over its percentage, stacked, in the pill docked at a side.
    var vertical = false
    @Environment(\.palette) private var palette
    /// The gauge whose tooltip is open: a row's label, or `models`.
    @State private var tip: String?
    /// Each gauge's frame, for the tooltip's arrow.
    @State private var frames: [String: CGRect] = [:]

    private static let models = "models"
    private static let space = "miniMonitor"

    var body: some View {
        let rows = Array(HardwareDials.rows(monitor).prefix(3))
        let count = monitor.engine?.resident.count ?? 0
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
        layout {
            if monitor.system == nil && monitor.gpu == nil {
                Text(monitor.error == nil ? LocalizedStringKey("Reading…") : "No readings").font(.caption2).foregroundStyle(palette.inkFaint)
            } else {
                ForEach(rows, id: \.label) { row in tipped(row.label) { gauge(row) } }
            }
            tipped(Self.models) {
                (vertical ? AnyLayout(VStackLayout(spacing: 2)) : AnyLayout(HStackLayout(spacing: 3))) {
                    Image(systemName: "cube").font(.caption2)
                    Text("\(count)").font(.caption2.monospacedDigit())
                }
                .foregroundStyle(count > 0 ? palette.accent : palette.inkFaint)
            }
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
        .coordinateSpace(.named(Self.space))
        .onTapGesture(perform: open)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { open() }
        // Outside the one accessibility element above, or VoiceOver could not reach the tooltip.
        .popover(isPresented: Binding(get: { tip != nil }, set: { if !$0 { tip = nil } }),
                 attachmentAnchor: .rect(.rect(tip.flatMap { frames[$0] } ?? .zero)), arrowEdge: .top) {
            if let tip {
                GaugeTip(monitor: monitor, id: tip) {
                    self.tip = nil
                    open()
                }
                .presentationCompactAdaptation(.popover)
            }
        }
        .accessibilityLabel("Monitor")
        .accessibilityValue(Self.spoken(rows, count: count))
        .accessibilityHint("Shows the hardware, loaded models and this chat’s details")
        .accessibilityIdentifier("chat.monitor")
    }

    /// A gauge that opens its tooltip on hover (a pointer). Touch and hold moves the pill instead.
    private func tipped(_ id: String, @ViewBuilder _ content: () -> some View) -> some View {
        content()
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { tip = id } else if tip == id { tip = nil }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { frames[id] = $0 }
    }

    private func gauge(_ row: HardwareDials.Row) -> some View {
        let tone: Color = palette.tone(MonitorTone.of(row.fraction))
        return (vertical ? AnyLayout(VStackLayout(spacing: 2)) : AnyLayout(HStackLayout(spacing: 4))) {
            ZStack {
                Circle().stroke(palette.surface2, lineWidth: 2)
                Circle().trim(from: 0, to: row.fraction ?? 0)
                    .stroke(tone, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 14, height: 14)
            Text(row.value).font(.caption2.monospacedDigit()).foregroundStyle(palette.inkSoft)
        }
    }

    private static func spoken(_ rows: [HardwareDials.Row], count: Int) -> String {
        let parts: [String] = rows.map { "\($0.label) \($0.value)" } + [String(localized: "\(count) models loaded")]
        return parts.joined(separator: ", ")
    }
}

/// One gauge in full, in the tooltip over the minimal monitor: its reading,
/// temperature and what it measures, or the loaded models; Details opens the
/// agent's panel.
struct GaugeTip: View {
    let monitor: HardwareMonitorModel
    /// A hardware row's label, or `models`.
    let id: String
    var details: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let row = HardwareDials.rows(monitor).first(where: { $0.label == id }) {
                HStack(spacing: 12) {
                    RingGauge(fraction: row.fraction, value: row.value, label: "", size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                        if let d = row.detail { Text(d).font(.caption).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true) }
                        if let t = row.temp {
                            let tone = MonitorTone.temperature(t)
                            Label("\(Int(t.rounded()))°C", systemImage: "thermometer.medium").font(.caption.monospacedDigit())
                                .foregroundStyle(tone == .ok ? palette.inkSoft : palette.tone(tone))
                        }
                    }
                }
            } else {
                Text("Loaded models").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                let resident = monitor.engine?.resident ?? []
                if resident.isEmpty {
                    Text("No local model is loaded.").font(.caption).foregroundStyle(palette.inkSoft)
                }
                ForEach(resident) { r in
                    HStack {
                        Text(monitor.name(r.id)).font(.caption.weight(.medium)).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        if let b = r.bytes { Text(MonitorFormat.bytes(b)).font(.caption.monospacedDigit()).foregroundStyle(palette.inkSoft) }
                    }
                }
            }
            Button(action: details) {
                Label("Details", systemImage: "chevron.down").font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("monitor.tip.details")
        }
        .padding(14)
        .frame(width: 240)
        // A container, so its id doesn't replace the Details button's.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("monitor.tip")
    }
}

/// Keeps `monitor` reading while the view is on screen: everything every few
/// seconds while the hardware shows (or the agent's panel is open), only the
/// Model Server every 10 s while Simple waits for a local model, and nothing
/// when every item in `ids` is hidden.
struct MonitorFollow: ViewModifier {
    @Binding var monitor: HardwareMonitorModel?
    /// The items that read the monitor; `hardware` decides the full reading.
    var ids: [String] = ["hardware"]
    var panelOpen = false
    @Environment(Prefs.self) private var prefs
    @Environment(ComputersStore.self) private var store

    func body(content: Content) -> some View {
        let wanted = panelOpen || ids.contains { SimpleMode.visibility($0, prefs.simpleChoices) != .hide }
        let full = panelOpen || prefs.shows("hardware", localModelLoaded: monitor?.localModelLoaded ?? false)
        let mode = !wanted ? 0 : full ? 2 : 1
        content.task(id: "\(mode) \(store.activeId ?? "")") {
            guard mode > 0 else { return }
            let m = monitor ?? HardwareMonitorModel(store: store)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-uiTestLocalModel") {
                let json = #"{"installed":true,"running":true,"resident":[{"id":"qwen3-8b","contextLength":32768,"vramBytes":5100000000,"loadedOn":"gpu"}],"memory":{"budgetBytes":24000000000,"kind":"unified"}}"#
                m.stubEngine = EngineStatus.from(try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
            }
            #endif
            monitor = m
            await m.follow(every: mode == 2 ? HardwareMonitorModel.interval : HardwareMonitorModel.engineInterval, engineOnly: mode == 1)
        }
    }
}

/// The agent's details, in the card the pill expands into: the
/// hardware with temperatures, the models the Model Server holds (with
/// Unload), and this chat's model, effort and context.
struct AgentPanel: View {
    let monitor: HardwareMonitorModel
    let chat: ChatModel?
    var close: () -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var notice: (text: String, ok: Bool)?

    var body: some View {
        let computer = store.active?.name ?? String(localized: "your computer")
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(chat?.title ?? computer).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                    Text("Agent on \(computer)").font(.caption).foregroundStyle(palette.inkSoft)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done", action: close).font(.body.weight(.semibold)).frame(minHeight: 44)
            }
            .padding(.horizontal, 20).padding(.top, 8)
            List {
                Section {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 12)], spacing: 14) {
                        HardwareDials(monitor: monitor, size: 60)
                    }
                    .padding(.vertical, 6)
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
                    Text("Loaded models").accessibilityIdentifier("monitor.models")
                } footer: {
                    Text("Unloading frees the model’s memory on \(computer). The next reply that uses it loads it again.")
                }
                if let chat {
                    Section("This chat") {
                        LabeledContent("Model", value: chat.modelName ?? String(localized: "Not chosen yet"))
                        LabeledContent("Effort", value: chat.effort.map(effortLabel) ?? String(localized: "Computer default"))
                        if chat.context != nil { ContextBreakdown(chat: chat).listRowInsets(EdgeInsets()) }
                    }
                }
                if let error = monitor.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.warning) }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .containerRelativeFrame(.vertical) { h, _ in h * 0.62 }
            .refreshable { await monitor.refresh() }
            if let notice {
                Label(notice.text, systemImage: notice.ok ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(notice.ok ? palette.ink : palette.danger)
                    .padding(.horizontal, 16).padding(.vertical, 6)
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
