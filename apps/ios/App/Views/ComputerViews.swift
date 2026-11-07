import NekkoKit
import NekkoProtocol
import SwiftUI

/// One paired computer, opened: what the phone knows about it in one page
/// (2026-10-24). The round trip is measured here; the rest is the computer's
/// own `machine:summary`, its models, providers and usage. Opening the page
/// makes the computer active over the link the phone keeps to it (2026-11-04),
/// so there is no Connect; Reconnect shows while it can't be reached. Rename,
/// open-at-launch and forget live in the Edit menu.
struct ComputerDetailView: View {
    let computerId: String
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(CloudSync.self) private var cloud
    @Environment(\.palette) private var palette
    @State private var model: MachineModel?
    @State private var renaming = false
    @State private var name = ""
    @State private var forgetting: Computer?
    @State private var addingProvider = false
    @State private var setup: ProviderSetupModel?
    @State private var switching: Set<String> = []
    @State private var pickingIcon = false
    @State private var iconError: String?
    @State private var modelsExpanded = false
    @State private var modelScope = ModelScope.all

    var body: some View {
        Group {
            if let c = store.computers.first(where: { $0.id == computerId }), let model {
                content(c, model)
            } else {
                ContentUnavailableView("This computer was forgotten", systemImage: "desktopcomputer")
            }
        }
        .appBackground()
        .navigationTitle("Computer")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: computerId) {
            // Its details come over the active connection: take its link over (no wait, no Connect).
            if store.activeId != computerId, store.computers.contains(where: { $0.id == computerId }) { store.connect(computerId) }
            if model?.computerId != computerId { model?.stop(); model = MachineModel(computerId: computerId, store: store) }
            model?.start()
        }
        .onDisappear { model?.stop() }
        .onChange(of: store.conn) { _, s in if s == .online { Task { await model?.refresh() } } }
        .forgetDialog($forgetting)
        .sheet(isPresented: $addingProvider) {
            if let model {
                AddProviderSheet(computer: store.computers.first { $0.id == computerId }?.name ?? "your computer",
                                 existing: model.providers.map(\.id)) { await model.refresh() }
            }
        }
        .alert("Couldn’t change that", isPresented: Binding(get: { setup?.failed != nil }, set: { if !$0 { setup = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(setup?.failed ?? "") }
        .alert("Couldn’t change that", isPresented: Binding(get: { iconError != nil }, set: { if !$0 { iconError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(iconError ?? "") }
        .sheet(isPresented: $pickingIcon) {
            ComputerIconPicker(current: store.computers.first { $0.id == computerId }?.icon) { name in
                pickingIcon = false
                Task { do { try await store.setMachineIcon(name) } catch { iconError = error.localizedDescription } }
            }
        }
    }

    @ViewBuilder private func content(_ c: Computer, _ m: MachineModel) -> some View {
        let s = m.summary
        List {
            Section {
                hero(c, s)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                tiles(c, m)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
            }
            Section {
                ComputerConnectionToggle(computer: c, focusOnConnect: true)
            } footer: {
                Text("Disconnecting keeps this pairing. This iPhone won’t reconnect until you turn it on again.")
                    .foregroundStyle(palette.inkSoft)
            }
            if canReconnect {
                Section {
                    Button { store.reconnect(computer: c.id) } label: { Label("Reconnect to \(c.name)", systemImage: "arrow.clockwise") }
                        .accessibilityIdentifier("computer.reconnect")
                } footer: {
                    Text("This phone keeps trying on its own; this tries again now. Its details show once it answers.").foregroundStyle(palette.inkSoft)
                }
            } else if let why = m.summaryError, m.loadedOnce {
                Section { Label(why, systemImage: "info.circle").font(.footnote).foregroundStyle(palette.inkSoft) }
            }
            if m.isActive {
                Section {
                    Button { pickingIcon = true } label: {
                        LabeledContent("Icon") {
                            if c.icon == nil { Text("None") } else { ComputerGlyph(icon: c.icon, size: 20).foregroundStyle(palette.ink) }
                        }
                    }
                    .foregroundStyle(palette.ink)
                    .disabled(store.conn != .online)
                    .accessibilityValue(c.icon.map(computerIconName) ?? String(localized: "None"))
                    .accessibilityIdentifier("computer.icon")
                } footer: {
                    Text(store.conn == .online ? "Saved on the computer; the desktop shows the same." : "Connect to change these.")
                        .foregroundStyle(palette.inkSoft)
                }
            }
            if !m.models.isEmpty || !m.providers.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $modelsExpanded) {
                        ModelScopeTabs(scope: $modelScope)
                        let filtered = modelScope.models(m.models, providers: m.providers)
                        if filtered.isEmpty {
                            Text("No models in this group.").font(.footnote).foregroundStyle(palette.inkSoft)
                        }
                        ForEach(Array(filtered.enumerated()), id: \.offset) { _, info in
                            modelRow(info, loaded: m.loadedIds.contains(info.id) || info.loaded, m)
                        }
                    } label: {
                        LabeledContent("Models", value: "\(m.models.count)")
                    }
                    .accessibilityIdentifier("computer.models")
                }
                Section {
                    ForEach(m.providers) { p in providerRow(p, c, m) }
                    if m.isActive {
                        Button { addingProvider = true } label: { Label("Add a provider", systemImage: "plus") }
                            .accessibilityIdentifier("computer.addProvider")
                    }
                } header: { SectionTitle("Providers") } footer: {
                    Text("A key you add here is sealed to \(c.name) before it leaves this iPhone, and never kept on the phone.").foregroundStyle(palette.inkSoft)
                }
            }
            if let s {
                Section {
                    if let cpu = s.cpuModel { LabeledContent("Chip", value: s.cpuCores.map { "\(cpu) · \($0) cores" } ?? cpu) }
                    if let ram = s.ramBytes {
                        LabeledContent("Memory") {
                            Text(s.memTotalMB.flatMap { total in s.memUsedMB.map { "\(bytes(ram))\(s.unified ? " unified" : "") · \(mb((total - $0))) free" } } ?? bytes(ram))
                        }
                    }
                    ForEach(s.gpus) { g in
                        LabeledContent("GPU") {
                            Text([g.name, g.cores.map { "\($0) cores" }, s.gpuC.map { "\(Int($0.rounded())) °C" }].compactMap { $0 }.joined(separator: " · "))
                        }
                    }
                    if let pct = s.cpuPct { LabeledContent("CPU now", value: "\(Int(pct.rounded()))%" + (s.cpuC.map { " · \(Int($0.rounded())) °C" } ?? "")) }
                    if !s.backends.isEmpty { LabeledContent("Backends", value: s.backends.joined(separator: ", ")) }
                    if let free = s.diskFreeBytes { LabeledContent("Free for models", value: bytes(free)) }
                } header: { SectionTitle("Hardware") }
            }
            if cloud.fleetEnabled, cloud.fleetConnected, let machine = cloud.machine(forComputer: computerId) {
                CloudMachineSections(machine: machine, computerId: computerId)
            }
            Section {
                NavigationLink(value: Route.connection) {
                    LabeledContent("Route", value: "\(routeName(c.route)) · \(c.relayHost)")
                }
                LabeledContent("Status", value: stateName(store.state(of: c.id)))
                LabeledContent("Paired") { Text(Date(timeIntervalSince1970: Double(c.pairedAt) / 1000), format: .relative(presentation: .named)) }
                if let v = s?.version ?? (m.isActive ? store.hostVersion : nil) {
                    LabeledContent("Nekko Agent", value: [v, s?.edition].compactMap { $0 }.joined(separator: " · "))
                }
            } header: { SectionTitle("Connection") }
            ComputerServiceSection(computerId: c.id)
            // Settings → This computer (SK-8): Security, sign out, stop remote access, quit.
            ThisComputerSection(computerId: c.id)
        }
        .listStyle(.plain)
        .listRowSeparatorTint(palette.line)
        .appBackground()
        .pawRefreshable { await m.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if canReconnect { Button { store.reconnect(computer: c.id) } label: { Label("Reconnect", systemImage: "arrow.clockwise") } }
                    Button { name = c.name; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                    if c.id != app.prefs.defaultComputer { Button { app.prefs.defaultComputer = c.id } label: { Label("Open at launch", systemImage: "star") } }
                    Button { Task { await m.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    Divider()
                    Button(role: .destructive) { forgetting = c } label: { Label("Forget…", systemImage: "trash") }
                } label: { Text("Edit") }
                .accessibilityIdentifier("computer.edit")
            }
        }
        .alert("Rename computer", isPresented: $renaming) {
            TextField("Name", text: $name)
            Button("Cancel", role: .cancel) {}
            Button("Save") { store.rename(c.id, to: name) }
        }
    }

    private func hero(_ c: Computer, _ s: MachineSummary?) -> some View {
        HStack(spacing: 12) {
            Group {
                if c.icon == nil {
                    Image(systemName: c.platform == "darwin" ? "laptopcomputer" : "desktopcomputer").font(.title2)
                } else {
                    ComputerGlyph(icon: c.icon, size: 26)
                }
            }
                .foregroundStyle(palette.accent).frame(width: 48, height: 48)
                .background(palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(c.name).font(.title2.weight(.bold)).foregroundStyle(palette.ink).lineLimit(1)
                HStack(spacing: 6) {
                    Circle().fill(dot).frame(width: 8, height: 8)
                    Text(subtitle(c, s)).font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(2)
                }
                if c.id == app.prefs.defaultComputer { RowChip(text: String(localized: "Opens at launch"), tone: .quiet) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    /// Not reachable now (the links retry by themselves): offer to dial at once.
    private var canReconnect: Bool {
        store.connectionEnabled(computerId) && ([.offline, .denied, .idle] as [RelayState]).contains(store.state(of: computerId))
    }

    private func subtitle(_ c: Computer, _ s: MachineSummary?) -> String {
        var parts = [stateName(store.state(of: c.id))]
        if let os = osName(s?.platform ?? c.platform, release: s?.release) { parts.append(os) }
        if let v = s?.version { parts.append("Nekko Agent \(v)") }
        return parts.joined(separator: " · ")
    }

    private func tiles(_ c: Computer, _ m: MachineModel) -> some View {
        let s = m.summary
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            Tile(title: "Round trip") {
                if let rt = m.latest {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(rt.ms)").font(.title3.weight(.bold).monospacedDigit())
                        Text("ms · \(routeName(c.route))").font(.caption).foregroundStyle(palette.inkFaint)
                    }
                    Sparkline(values: m.samples.map { Double($0.ms) }).frame(height: 22)
                        .accessibilityLabel("Round trip, last \(m.samples.count) samples")
                } else {
                    Text(m.isActive ? "Measuring…" : "—").font(.title3.weight(.bold)).foregroundStyle(palette.inkFaint)
                }
            }
            Tile(title: "Model server") {
                if let s {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(s.serverRunning ? "\(s.resident.count) loaded" : "Off").font(.title3.weight(.bold))
                        if s.loading > 0 { Text("· \(s.loading) loading").font(.caption).foregroundStyle(palette.inkFaint) }
                    }
                    if let used = s.gpuUsedMB, let total = s.gpuTotalMB, total > 0 {
                        Bar(fraction: used / total)
                        Text("\(mb(used)) of \(mb(total))\(s.unified ? " unified" : "")").font(.caption2).foregroundStyle(palette.inkFaint)
                    }
                } else { Text("—").font(.title3.weight(.bold)).foregroundStyle(palette.inkFaint) }
            }
            Tile(title: "Up") {
                Text(s.map { AgentRows.span(ms: Double($0.uptimeMs)) } ?? "—").font(.title3.weight(.bold).monospacedDigit())
                Text("Paired \(Date(timeIntervalSince1970: Double(c.pairedAt) / 1000), format: .relative(presentation: .named))")
                    .font(.caption2).foregroundStyle(palette.inkFaint)
            }
            Tile(title: "Today") {
                if let d = m.today {
                    Text(d.cost, format: .currency(code: "USD").precision(.fractionLength(2))).font(.title3.weight(.bold).monospacedDigit())
                    Text("\(d.tokens.formatted(.number.notation(.compactName))) tokens").font(.caption2).foregroundStyle(palette.inkFaint)
                } else { Text("$0.00").font(.title3.weight(.bold).monospacedDigit()); Text("No usage yet").font(.caption2).foregroundStyle(palette.inkFaint) }
            }
        }
    }

    private func modelRow(_ info: ModelInfo, loaded: Bool, _ m: MachineModel) -> some View {
        let provider = m.providers.first { $0.id == info.providerId }
        return HStack(spacing: 10) {
            Image(systemName: loaded ? "circle.fill" : "circle").font(.caption2).foregroundStyle(loaded ? palette.success : palette.inkFaint)
                .frame(width: 16).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(info.name).font(.body).foregroundStyle(palette.ink).lineLimit(1)
                Text([provider?.label, loaded ? String(localized: "loaded") : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(palette.inkFaint)
            }
            Spacer()
            if store.defaults.defaultModelId == info.id { RowChip(text: String(localized: "Default"), tone: .quiet) }
        }
        .accessibilityElement(children: .combine)
    }

    private func providerRow(_ p: PublicProvider, _ c: Computer, _ m: MachineModel) -> some View {
        // The switch is a change on the computer (Face ID, like every change); the row waits for its answer.
        Toggle(isOn: Binding(get: { p.enabled }, set: { on in flip(p, on, m) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.label).font(.body).foregroundStyle(p.enabled ? palette.ink : palette.inkSoft)
                Text(kindName(p.kind)).font(.caption).foregroundStyle(palette.inkFaint)
            }
        }
        .disabled(!m.isActive || switching.contains(p.id))
        .tint(palette.success)
        .accessibilityIdentifier("computer.provider.\(p.id)")
    }

    private func flip(_ p: PublicProvider, _ on: Bool, _ m: MachineModel) {
        let model = setup ?? ProviderSetupModel(store: store)
        setup = model
        switching.insert(p.id)
        Task {
            _ = await model.setEnabled(p.id, on)
            await m.refresh()
            switching.remove(p.id)
        }
    }

    private var dot: Color {
        switch store.state(of: computerId) {
        case .online: return palette.success
        case .connecting: return palette.running
        case .offline: return palette.warning
        case .denied: return palette.danger
        case .idle: return palette.inkFaint
        }
    }

    private func kindName(_ kind: String) -> String {
        switch kind {
        case "anthropic": return "Anthropic · API key"
        case "openai": return "OpenAI · API key"
        case "openrouter": return "OpenRouter · API key"
        case "chatgpt": return "ChatGPT · subscription"
        case "llamacpp": return "Local Model Server"
        case "ollama": return "Ollama · local"
        case "lmstudio": return "LM Studio · local"
        case "vllm": return "vLLM · local"
        case "openai-compat": return "OpenAI-compatible"
        case "bedrock": return "Amazon Bedrock"
        case "vertex": return "Google Vertex"
        case "foundry": return "Azure AI Foundry"
        default: return kind
        }
    }

    private func osName(_ platform: String?, release: String?) -> String? {
        switch platform {
        case "darwin": return "macOS"
        case "win32": return "Windows"
        case "linux": return "Linux"
        default: return platform
        }
    }

    private func bytes(_ b: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(b), countStyle: .memory) }
    private func mb(_ v: Double) -> String { bytes(v * 1_048_576) }
}

/// A computer's icon beside its name, or nothing at all when it has none. Decorative: the name says which.
struct ComputerGlyph: View {
    let icon: String?
    var size: CGFloat = 16
    @ScaledMetric private var scale: CGFloat = 1

    var body: some View {
        if let icon {
            Image("computer-\(icon)").resizable().scaledToFit().frame(width: size * scale, height: size * scale)
                .accessibilityHidden(true)
        }
    }
}

/// A computer in a menu or a picker, which keep only a title and an image.
struct ComputerLabel: View {
    let c: Computer

    var body: some View {
        if let icon = c.icon {
            Label(c.name, image: "computer-\(icon)")
        } else {
            Text(c.name)
        }
    }
}

/// The name a picker's button reads out for an icon.
func computerIconName(_ icon: String) -> String {
    switch icon {
    case "laptop": return String(localized: "Laptop")
    case "desktop": return String(localized: "Desktop")
    case "tower": return String(localized: "Tower")
    case "mini": return String(localized: "Mini")
    case "server": return String(localized: "Server")
    case "rack": return String(localized: "Rack")
    case "cloud": return String(localized: "Cloud")
    case "gpu": return String(localized: "GPU")
    case "chip": return String(localized: "Chip")
    case "home": return String(localized: "Home")
    case "office": return String(localized: "Office")
    case "lab": return String(localized: "Lab")
    case "bolt": return String(localized: "Bolt")
    case "moon": return String(localized: "Moon")
    case "sun": return String(localized: "Sun")
    case "star": return String(localized: "Star")
    case "flame": return String(localized: "Flame")
    case "leaf": return String(localized: "Leaf")
    case "globe": return String(localized: "Globe")
    case "cube": return String(localized: "Cube")
    case "rocket": return String(localized: "Rocket")
    case "shield": return String(localized: "Shield")
    case "terminal": return String(localized: "Terminal")
    case "cat": return String(localized: "Cat")
    default: return icon
    }
}

/// None and the 24 icons. Picking closes it; the computer saves the choice.
private struct ComputerIconPicker: View {
    let current: String?
    let onPick: (String) -> Void
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 52), spacing: 8)], spacing: 8) {
                    cell(icon: "", label: String(localized: "None")) { Text("None").font(.footnote).lineLimit(1).minimumScaleFactor(0.7) }
                    ForEach(computerIcons, id: \.self) { icon in
                        cell(icon: icon, label: computerIconName(icon)) { ComputerGlyph(icon: icon, size: 24) }
                    }
                }
                .padding(16)
            }
            .appBackground()
            .navigationTitle("Icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func cell(icon: String, label: String, @ViewBuilder content: () -> some View) -> some View {
        let selected = icon == (current ?? "")
        return Button { onPick(icon) } label: {
            content().foregroundStyle(palette.ink).frame(maxWidth: .infinity, minHeight: 52)
                .background(selected ? palette.accent.opacity(0.12) : palette.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay { if selected { RoundedRectangle(cornerRadius: 12).stroke(palette.accent) } }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("computer.icon.\(icon.isEmpty ? "none" : icon)")
    }
}

/// A stat tile: a small uppercase title, then whatever the stat needs.
private struct Tile<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint).textCase(.uppercase).kerning(0.5)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

private struct Bar: View {
    let fraction: Double
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.surface2)
                Capsule().fill(palette.accent).frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// The last round trips as a line with a faint fill, drawn to its own scale.
struct Sparkline: View {
    let values: [Double]
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let n = values.count
            let lo = values.min() ?? 0, hi = max(values.max() ?? 1, lo + 1)
            let points: [CGPoint] = values.enumerated().map { i, v in
                CGPoint(x: n > 1 ? CGFloat(i) / CGFloat(n - 1) * w : w, y: h - CGFloat((v - lo) / (hi - lo)) * (h - 4) - 2)
            }
            if let first = points.first, let last = points.last {
                Path { p in
                    p.move(to: CGPoint(x: first.x, y: h))
                    for pt in points { p.addLine(to: pt) }
                    p.addLine(to: CGPoint(x: last.x, y: h))
                    p.closeSubpath()
                }
                .fill(palette.accent.opacity(0.12))
                Path { p in
                    p.move(to: first)
                    for pt in points.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(palette.accent, lineWidth: 1.5)
                Circle().fill(palette.accent).frame(width: 4, height: 4).position(last)
            }
        }
    }
}

/// Add a provider to the computer from this iPhone: pick a kind, paste the
/// key, name it. The key is sealed to the computer before it leaves the phone.
struct AddProviderSheet: View {
    let computer: String
    let existing: [String]
    var done: () async -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var model: ProviderSetupModel?
    @State private var kind = ProviderSetup.kinds[0]
    @State private var key = ""
    @State private var label = ""
    @State private var url = ""
    @State private var models: [ProviderSaveResult.Model] = []
    @FocusState private var keyFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                        ForEach(ProviderSetup.kinds) { k in
                            Button { pick(k) } label: {
                                Text(k.label).font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                                    .foregroundStyle(k.id == kind.id ? palette.onAccent : palette.ink)
                                    .background(k.id == kind.id ? palette.accent : palette.surface2, in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(k.id == kind.id ? .isSelected : [])
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                } header: { Text("Kind") }
                if kind.needsKey {
                    Section {
                        SecureField("Paste the API key", text: $key)
                            .textContentType(.password).autocorrectionDisabled().textInputAutocapitalization(.never)
                            .focused($keyFocused)
                            .accessibilityIdentifier("provider.key")
                    } header: { Text("API key") } footer: {
                        Label("Sealed to \(computer) before it leaves this iPhone. The key is encrypted to the computer’s own key, sent once over the end-to-end encrypted relay, and never written on this phone. \(computer) tests it and keeps it in its own keychain.", systemImage: "lock.fill")
                            .foregroundStyle(palette.inkSoft)
                    }
                }
                if kind.takesUrl {
                    Section {
                        TextField(kind.defaultUrl, text: $url).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                            .accessibilityIdentifier("provider.url")
                    } header: { Text("Address") } footer: {
                        Text("As \(computer) reaches it: localhost means the computer itself.").foregroundStyle(palette.inkSoft)
                    }
                }
                Section {
                    TextField(kind.label, text: $label)
                        .accessibilityIdentifier("provider.label")
                } header: { Text("Name") }
                if let failed = model?.failed {
                    Section { Label(failed, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
                }
                if !models.isEmpty {
                    Section {
                        ForEach(models.prefix(12)) { m in Text(m.name).foregroundStyle(palette.ink) }
                        if models.count > 12 { Text("and \(models.count - 12) more").foregroundStyle(palette.inkFaint) }
                    } header: { Text("Saved · models \(computer) can use") }
                }
            }
            .navigationTitle("Add a provider")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(models.isEmpty ? "Cancel" : "Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if models.isEmpty {
                        Button { save() } label: {
                            if model?.busy == true { ProgressView() } else { Text("Save to \(computer)") }
                        }
                        .disabled(model?.busy == true || (kind.needsKey && key.trimmingCharacters(in: .whitespaces).isEmpty))
                        .accessibilityIdentifier("provider.save")
                    }
                }
            }
            .onAppear { if model == nil { model = ProviderSetupModel(store: store) }; keyFocused = kind.needsKey }
        }
        .presentationDetents([.large])
    }

    private func pick(_ k: ProviderSetup.Kind) {
        kind = k
        if !k.needsKey { key = "" }
        if !k.takesUrl { url = "" }
    }

    private func save() {
        guard let model else { return }
        let name = label.trimmingCharacters(in: .whitespaces).isEmpty ? kind.label : label
        let id = ProviderSetup.id(for: name, kind: kind.id, existing: existing)
        Task {
            let ok = await model.save(id: id, kind: kind.id, label: name, baseUrl: kind.takesUrl ? (url.isEmpty ? kind.defaultUrl : url) : nil, key: kind.needsKey ? key : nil)
            // The key is dropped the moment the call returns, whatever happened.
            key = ""
            if ok {
                models = model.saved?.models ?? []
                Haptics.tap()
                await done()
            }
        }
    }
}

/// A Nekko Cloud machine's own sections on its computer page: the machine,
/// and what the cloud may see (decision 0017), each change a call to Nekko Cloud.
struct CloudMachineSections: View {
    let machine: CloudSync.Machine
    let computerId: String
    @Environment(CloudSync.self) private var cloud
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false

    var body: some View {
        Section {
            LabeledContent("State", value: machine.state.capitalized)
            LabeledContent("Region", value: machine.region.uppercased())
            LabeledContent("Hours this month", value: "\(machine.hoursUsed.formatted(.number.precision(.fractionLength(1)))) of \(Int(machine.hoursIncluded))")
            LabeledContent("Sandbox", value: "Jailed · no LAN · stops when idle")
            if machine.state == "running" {
                Button { run { try await cloud.stopMachine(machine) } } label: { Label("Stop", systemImage: "stop.circle") }.disabled(busy)
            } else {
                Button { run { try await cloud.startMachine(machine); store.connect(computerId) } } label: { Label("Start", systemImage: "play.circle") }.disabled(busy)
            }
        } header: { SectionTitle("Nekko Cloud machine") } footer: {
            Text("Stopping keeps its disk; the chat stays readable from the synced copy.").foregroundStyle(palette.inkSoft)
        }
        Section {
            ForEach(machine.scope.repos, id: \.self) { r in
                Text(r).font(.body.monospaced()).foregroundStyle(palette.ink)
                    .swipeActions { Button(role: .destructive) { setScope { $0.repos.removeAll { $0 == r } } } label: { Label("Remove", systemImage: "trash") } }
            }
            HStack {
                TextField("owner/repo", text: $repo).autocorrectionDisabled().textInputAutocapitalization(.never).font(.body.monospaced())
                    .accessibilityIdentifier("cloud.repo")
                Button("Allow") {
                    let r = repo.trimmingCharacters(in: .whitespaces)
                    guard r.contains("/") else { return }
                    setScope { if !$0.repos.contains(r) { $0.repos.append(r) } }
                    repo = ""
                }
                .disabled(busy || !repo.contains("/"))
            }
            Toggle("Privacy Shield on every cloud model request", isOn: Binding(get: { machine.scope.privacyShield }, set: { v in setScope { $0.privacyShield = v } }))
                .disabled(busy)
            Toggle("Memory, rules and prompts from my computers", isOn: Binding(get: { machine.scope.memory }, set: { v in setScope { $0.memory = v } }))
                .disabled(busy)
            Toggle("Sync chats back to my account", isOn: Binding(get: { machine.scope.syncBack }, set: { v in setScope { $0.syncBack = v } }))
                .disabled(busy)
            if let error { Text(error).font(.footnote).foregroundStyle(palette.danger) }
        } header: { SectionTitle("What the cloud may see") } footer: {
            Text("Only what is listed here reaches the machine: these repositories, your own provider keys (sealed to it), and nothing from your computers unless you turn it on. A change applies when the machine next starts.")
                .foregroundStyle(palette.inkSoft)
        }
        Section {
            Button(role: .destructive) { confirmDelete = true } label: { Label("Stop and delete this machine", systemImage: "trash") }
                .disabled(busy)
                .confirmationDialog("Delete this machine?", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) {
                        run {
                            try await cloud.deleteMachine(machine)
                            store.forget(computerId)
                            dismiss()
                        }
                    }
                } message: {
                    Text("Its disk and its pairing go with it. Synced chats stay on your account.")
                }
        }
    }

    private func setScope(_ change: (inout CloudSync.MachineScope) -> Void) {
        var scope = machine.scope
        change(&scope)
        run { try await cloud.setScope(machine, scope) }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
