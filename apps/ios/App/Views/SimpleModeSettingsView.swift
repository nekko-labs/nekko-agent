import SwiftUI

/// Settings > Simple mode: per control, whether it shows in both modes, in
/// Expert only, or in neither, each area drawn above its controls with what
/// the previewed mode hides outlined in dashes and faded.
struct SimpleModeSettingsView: View {
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var previewExpert = false
    /// The control just touched, outlined in the preview for a moment.
    @State private var flash: String?

    var body: some View {
        Form {
            Section {
                Text("Simple keeps Nekko calm for everyday use. Everything still works; these controls just stay out of sight.")
                    .foregroundStyle(palette.inkSoft)
                Picker("Preview", selection: $previewExpert) {
                    Text("Simple").tag(false)
                    Text("Expert").tag(true)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("simpleMode.preview")
            }
            ForEach(SimpleMode.areas, id: \.area) { group in
                Section {
                    SimpleAreaPreview(items: group.items, expert: previewExpert, choices: prefs.simpleChoices, flash: flash)
                        .listRowBackground(palette.surface2)
                    ForEach(group.items) { row($0) }
                } header: {
                    Text(group.area).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).textCase(nil)
                }
            }
            Section {
                Button("Reset to defaults") { prefs.simpleChoices = [:] }
                    .disabled(prefs.simpleChoices.isEmpty)
                    .accessibilityIdentifier("simpleMode.reset")
            }
        }
        .appBackground()
        .navigationTitle("Simple mode")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ item: SimpleItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.label).foregroundStyle(palette.ink)
                Text(item.hint).font(.footnote).foregroundStyle(palette.inkSoft)
                if SimpleMode.withLocalModel.contains(item.id) {
                    Text("Also shown in Simple while a local model is loaded").font(.footnote).foregroundStyle(palette.inkFaint)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { highlight(item.id) }
            Picker(item.label, selection: Binding(get: { SimpleMode.visibility(item.id, prefs.simpleChoices) }, set: { v in
                prefs.simpleChoices[item.id] = v == item.fallback ? nil : v
                highlight(item.id)
            })) {
                ForEach(SimpleVisibility.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("simpleMode.\(item.id)")
        }
        .padding(.vertical, 4)
    }

    private func highlight(_ id: String) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { flash = id }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            if flash == id { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { flash = nil } }
        }
    }
}

/// A small drawing of one area: each control in it drawn plainly when the
/// previewed mode shows it, dashed and faded when it hides it.
private struct SimpleAreaPreview: View {
    let items: [SimpleItem]
    let expert: Bool
    let choices: [String: SimpleVisibility]
    let flash: String?
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch items.first?.id {
            case "changes": header
            case "model": messageBox
            case "thinking": conversation
            case "terminal": addMenu
            default: chatsList
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
    }

    // MARK: Areas

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left").foregroundStyle(palette.accent)
                Spacer(minLength: 4)
                VStack(spacing: 4) {
                    Text("Fix the login page").font(.caption.weight(.semibold)).foregroundStyle(palette.ink)
                    part("ph-subtitle") { Text("Opus 5.5 · Studio Mac").font(.caption2).lineLimit(1).fixedSize() }
                }
                Spacer(minLength: 4)
                Image(systemName: "ellipsis.circle").foregroundStyle(palette.accent)
            }
            .padding(.bottom, 8)
            // The slim second row: the switch, and the minimal monitor.
            HStack(spacing: 8) {
                HStack(spacing: 0) {
                    Image(systemName: "bubble.left").font(.caption2).foregroundStyle(palette.onAccent)
                        .frame(width: 26, height: 18).background(palette.accent, in: Capsule())
                    Image(systemName: "chevron.left.forwardslash.chevron.right").font(.caption2).foregroundStyle(palette.inkSoft)
                        .frame(width: 26, height: 18)
                }
                .background(palette.surface, in: Capsule())
                Spacer(minLength: 4)
                part("hardware") {
                    HStack(spacing: 8) {
                        ForEach(Array(zip(["CPU", "Memory", "GPU"], [0.43, 0.79, 0.23])), id: \.0) { name, f in
                            HStack(spacing: 3) {
                                Circle().trim(from: 0, to: f).stroke(palette.accent, lineWidth: 1.5).rotationEffect(.degrees(-90)).frame(width: 10, height: 10)
                                Text("\(Int(f * 100))%").font(.caption2.monospacedDigit())
                            }
                        }
                        HStack(spacing: 2) { Image(systemName: "cube"); Text("1") }.font(.caption2)
                    }
                }
            }
            .padding(.bottom, 6)
            Rectangle().fill(palette.line).frame(height: 1)
            HStack(spacing: 6) {
                Text("More menu").font(.caption2).foregroundStyle(palette.inkFaint)
                part("changes") { tag("Changes", "plusminus") }
            }
            .padding(.top, 8)
        }
    }

    private var messageBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            RoundedRectangle(cornerRadius: 14).fill(palette.surface).frame(height: 40)
                .overlay(alignment: .leading) { Text("Message").font(.caption).foregroundStyle(palette.inkFaint).padding(.leading, 12) }
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(palette.line))
            HStack(spacing: 6) {
                part("effort") { tag("Effort", "gauge.with.dots.needle.33percent") }
                part("model") { Text("Opus 5.5").font(.caption2) }
                Spacer(minLength: 4)
                part("context") { tag("48k / 200k", "circle.dashed") }
            }
            HStack(spacing: 6) {
                Text("More menu").font(.caption2).foregroundStyle(palette.inkFaint)
                part("ph-policy") { tag("Tool policy", "shield.lefthalf.filled") }
            }
        }
    }

    private var conversation: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Spacer()
                Text("Fix the login page").font(.caption2).foregroundStyle(palette.userInk)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 12))
            }
            part("thinking", wide: true) {
                VStack(alignment: .leading, spacing: 3) {
                    tag("Thought", "brain")
                    tag("Read 3 files", "checkmark")
                    tag("Ran the tests", "checkmark")
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Capsule().fill(palette.line).frame(height: 6)
                Capsule().fill(palette.line).frame(width: 160, height: 6)
            }
            part("ph-git") { tag("PR #42 · checks passing", "arrow.triangle.pull") }
        }
    }

    private var addMenu: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("New, or + in the message box").font(.caption2).foregroundStyle(palette.inkFaint)
            HStack(spacing: 6) {
                tag("New agent", "plus.bubble").modifier(Chip(shown: true, flashing: false))
                part("terminal") { tag("Terminal", "terminal") }
                tag("Photos", "photo").modifier(Chip(shown: true, flashing: false))
            }
        }
    }

    private var chatsList: some View {
        VStack(alignment: .leading, spacing: 6) {
            part("ph-monitors", wide: true) { tag("Monitors", "gauge.with.dots.needle.50percent") }
            ForEach(["Fix the login page", "Plan the release"], id: \.self) { title in
                HStack {
                    Text(LocalizedStringKey(title)).font(.caption2).foregroundStyle(palette.ink)
                    Spacer()
                    Capsule().fill(palette.line).frame(width: 30, height: 6)
                }
                .padding(.horizontal, 10).frame(height: 26)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    // MARK: Parts

    /// An icon and words, tight: a List's own Label style spaces them a whole column apart.
    private func tag(_ title: LocalizedStringKey, _ icon: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
            Text(title).lineLimit(1)
        }
        .font(.caption2)
    }

    private func shown(_ id: String) -> Bool { SimpleMode.shown(id, expert: expert, choices) }

    private func part<Content: View>(_ id: String, wide: Bool = false, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: wide ? .infinity : nil, alignment: .leading)
            .modifier(Chip(shown: shown(id), flashing: flash == id))
    }

    private var summary: String {
        let on = items.filter { shown($0.id) }.map(\.label)
        let off = items.filter { !shown($0.id) }.map(\.label)
        let mode = expert ? String(localized: "Expert") : String(localized: "Simple")
        return [String(localized: "Preview in \(mode)"),
                on.isEmpty ? nil : String(localized: "Shown: \(on.joined(separator: ", "))"),
                off.isEmpty ? nil : String(localized: "Hidden: \(off.joined(separator: ", "))")]
            .compactMap { $0 }.joined(separator: ". ")
    }
}

/// A control in the preview: solid when shown, dashed and faded when hidden,
/// outlined in the accent for a moment when its row was touched.
private struct Chip: ViewModifier {
    let shown: Bool
    let flashing: Bool
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        content
            .foregroundStyle(shown ? palette.ink : palette.inkFaint)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(shown ? palette.surface : .clear, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(shown ? palette.line : palette.inkFaint, style: StrokeStyle(lineWidth: 1, dash: shown ? [] : [4, 3]))
            }
            .opacity(shown ? 1 : 0.45)
            .overlay {
                if flashing {
                    RoundedRectangle(cornerRadius: 10).strokeBorder(palette.accent, lineWidth: 2).padding(-3)
                }
            }
    }
}
