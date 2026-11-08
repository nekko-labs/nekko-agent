import SwiftUI

/// Shared by the final onboarding step and Settings. It never requests access
/// on appearance, and continuing does not imply every optional tool is enabled.
/// One row is open at a time; a grant (or Skip) checks it off and opens the next.
struct PermissionChecklistView: View {
    var finish: (() -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var permissions = PermissionChecklist()
    @State private var request: Task<Void, Never>?
    @State private var focus: PermissionChecklist.Item?
    @State private var skipped: Set<PermissionChecklist.Item> = []
    @State private var shown = false
    @State private var mood = Mood.idle

    private enum Mood { case idle, cheer, oops }
    private static let recommended: [PermissionChecklist.Item] = [.notifications, .network]
    private static let optional: [PermissionChecklist.Item] = [.liveActivities, .camera, .microphone, .speech, .authentication, .photos]

    private func resolved(_ item: PermissionChecklist.Item) -> Bool {
        let state = permissions.status(item)
        return state.checked || !state.canRequest || skipped.contains(item)
    }
    private var active: PermissionChecklist.Item? {
        focus ?? PermissionChecklist.Item.allCases.first { !resolved($0) }
    }
    /// The next unfinished row after this one, wrapping, so the flow moves forward.
    private func next(after item: PermissionChecklist.Item) -> PermissionChecklist.Item? {
        let all = PermissionChecklist.Item.allCases
        let start = all.firstIndex(of: item)! + 1
        return (all[start...] + all[..<start]).first { $0 != item && !resolved($0) }
    }
    private var checkedCount: Int { PermissionChecklist.Item.allCases.filter { permissions.status($0).checked }.count }
    private var deniedCount: Int { PermissionChecklist.Item.allCases.filter { permissions.status($0) == .denied }.count }
    private var allDone: Bool { PermissionChecklist.Item.allCases.allSatisfy(resolved) }
    private var motion: Animation? { reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.82) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if finish != nil { StepLabel(step: 3) }
                header
                section("Recommended", Self.recommended, offset: 0)
                section("Optional", Self.optional, offset: Self.recommended.count)
                footer
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
                Button(action: finish) {
                    Text(allDone ? "Done" : "Continue").frame(maxWidth: .infinity).padding(.vertical, 6)
                        .foregroundStyle(palette.onAccent)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("permissions.continue")
                .frame(maxWidth: 680)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .frame(maxWidth: .infinity).background(.bar)
            }
        }
        .task {
            await permissions.refresh()
            withAnimation(motion) { shown = true }
        }
        .onChange(of: phase) { _, phase in
            if phase == .active { Task { await permissions.refresh() } }
            if phase == .background { request?.cancel(); permissions.stop() }
        }
        .onChange(of: checkedCount) { old, new in if new > old { react(.cheer) } }
        .onChange(of: deniedCount) { old, new in if new > old { react(.oops) } }
        .onDisappear { request?.cancel(); permissions.stop() }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                mascot
                VStack(alignment: .leading, spacing: 4) {
                    Text(allDone ? "All set" : "Let’s set up Nekko")
                        .font(.title.weight(.bold)).foregroundStyle(palette.ink)
                        .accessibilityAddTraits(.isHeader)
                        .contentTransition(.opacity)
                    Text(allDone ? "Change anything here later." : "Allow what you’ll use. Skip the rest.")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                        .contentTransition(.opacity)
                }
            }
            HStack(spacing: 10) {
                ProgressView(value: Double(checkedCount), total: Double(PermissionChecklist.Item.allCases.count))
                    .tint(palette.accent)
                    .animation(motion, value: checkedCount)
                    .accessibilityHidden(true) // A system ProgressView audits as a too-small control; the count says it.
                Text("\(checkedCount) of \(PermissionChecklist.Item.allCases.count)")
                    .font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(palette.inkSoft)
                    .contentTransition(.numericText(value: Double(checkedCount)))
                    .accessibilityLabel("\(checkedCount) of \(PermissionChecklist.Item.allCases.count) allowed")
                    .accessibilityIdentifier("permissions.progress")
            }
        }
        .animation(motion, value: allDone)
    }

    /// Blinks while waiting, cheers on a grant, looks startled at a denial.
    /// Her face is decoration only; status text is the proof of access.
    private var mascot: some View {
        TimelineView(.animation(minimumInterval: 0.2, paused: reduceMotion || phase != .active)) { timeline in
            let frame = Int(timeline.date.timeIntervalSinceReferenceDate * 5) % 40
            PixelCat(happy: mood == .cheer || allDone, shocked: mood == .oops, blink: mood == .idle && !allDone && frame == 14,
                     fill: palette.surface2, line: palette.ink)
                .frame(width: 56, height: 56)
                .offset(y: mood == .cheer && !reduceMotion ? -4 : 0)
                .scaleEffect(mood == .oops && !reduceMotion ? 1.06 : 1)
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.5), value: mood)
        .accessibilityHidden(true)
    }

    private func react(_ next: Mood) {
        mood = next
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            if mood == next { mood = .idle }
        }
    }

    // MARK: Rows

    private func section(_ title: LocalizedStringKey, _ items: [PermissionChecklist.Item], offset: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(palette.inkSoft)
                .textCase(.uppercase).accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element) { index, item in
                    if index > 0 { Divider().overlay(palette.line).padding(.leading, 52) }
                    row(item)
                        .opacity(shown ? 1 : 0)
                        .offset(y: shown || reduceMotion ? 0 : 10)
                        .animation(reduceMotion ? nil : .spring(response: 0.45, dampingFraction: 0.85).delay(Double(offset + index) * 0.05), value: shown)
                }
            }
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.line))
        }
    }

    private func row(_ item: PermissionChecklist.Item) -> some View {
        let state = permissions.status(item)
        let open = active == item
        return VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(motion) { focus = open ? nil : item }
            } label: {
                HStack(spacing: 12) {
                    glyph(item, state: state, open: open)
                    Text(item.title).font(open ? .headline : .body).foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !open { trailing(item, state: state) }
                }
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("permissions.row.\(item.rawValue)")
            .accessibilityValue(statusText(item, state: state))
            .accessibilityHint(open ? "" : String(localized: "Shows details"))

            if open {
                VStack(alignment: .leading, spacing: 12) {
                    Text(item.detail).font(.subheadline).foregroundStyle(palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                    if let message = permissions.message {
                        Text(message).font(.footnote).foregroundStyle(palette.inkSoft)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("permissions.message")
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { action(item, state: state); skip(item, state: state) }
                        VStack(alignment: .leading, spacing: 8) { action(item, state: state); skip(item, state: state) }
                    }
                }
                .padding(.leading, 40)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(open ? palette.surface2.opacity(0.6) : .clear)
        .clipped()
        .accessibilityElement(children: .contain)
    }

    /// Status is shape plus text, never color alone.
    private func glyph(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access, open: Bool) -> some View {
        let symbol: String
        let tint: Color
        if state.checked { symbol = "checkmark.circle.fill"; tint = palette.success }
        else if state == .denied { symbol = "exclamationmark.circle.fill"; tint = palette.warning }
        else if !state.canRequest || skipped.contains(item) { symbol = "minus.circle"; tint = palette.inkFaint }
        else if open { symbol = item.icon; tint = palette.accent }
        else { symbol = "circle"; tint = palette.inkFaint }
        return Image(systemName: symbol)
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(tint)
            .contentTransition(.symbolEffect(.replace))
            .symbolEffect(.bounce, value: state.checked)
            .frame(width: 28, height: 28)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.label)
            .accessibilityIdentifier("permissions.status.\(item.rawValue)")
    }

    @ViewBuilder
    private func trailing(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> some View {
        let text = statusText(item, state: state)
        if !text.isEmpty {
            Text(text).font(.footnote).foregroundStyle(state == .denied ? palette.warning : palette.inkSoft)
                .accessibilityHidden(true)
        }
    }

    private func statusText(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> String {
        if state.checked || state == .denied || !state.canRequest { return state.label }
        if skipped.contains(item) { return String(localized: "Skipped") }
        return ""
    }

    private func action(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> some View {
        Button {
            if state.checked || state == .denied || item == .liveActivities {
                PermissionChecklist.openSettings()
            } else {
                request = Task {
                    await permissions.request(item)
                    await app.permissionChecklistChanged()
                    // Advance only on a real grant; a denial stays open with its Settings fix.
                    if permissions.status(item).checked { withAnimation(motion) { focus = next(after: item) } }
                }
            }
        } label: {
            HStack(spacing: 8) {
                if permissions.busy == item { ProgressView().controlSize(.small).tint(palette.onAccent) }
                Text(buttonTitle(item, state: state)).foregroundStyle(palette.onAccent)
            }
            .frame(minHeight: 30)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!state.canRequest || permissions.busy != nil)
        .accessibilityLabel("\(buttonTitle(item, state: state)): \(item.title)")
        .accessibilityIdentifier("permissions.action.\(item.rawValue)")
    }

    @ViewBuilder
    private func skip(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> some View {
        if !state.checked && state.canRequest {
            Button {
                withAnimation(motion) { skipped.insert(item); focus = next(after: item) }
            } label: {
                Text("Not now").frame(minHeight: 30)
            }
            .buttonStyle(.bordered)
            .tint(palette.inkSoft)
            .disabled(permissions.busy != nil)
            .accessibilityLabel("Not now: \(item.title)")
            .accessibilityIdentifier("permissions.skip.\(item.rawValue)")
        }
    }

    private func buttonTitle(_ item: PermissionChecklist.Item, state: PermissionChecklist.Access) -> String {
        if permissions.busy == item { return String(localized: "Checking…") }
        if !state.canRequest { return state.label }
        if state.checked || state == .denied || item == .liveActivities { return String(localized: "Settings") }
        if item == .network { return String(localized: "Look nearby") }
        if item == .authentication { return String(localized: "Try it") }
        return String(localized: "Allow")
    }

    // MARK: Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing here is required. Picking photos and files never needs library access.")
                .font(.footnote).foregroundStyle(palette.inkSoft)
            Button { PermissionChecklist.openSettings() } label: {
                Text("Open system Settings").multilineTextAlignment(.leading)
            }
                .font(.footnote.weight(.semibold))
                .frame(minHeight: 44)
                .disabled(permissions.busy != nil)
                .accessibilityIdentifier("permissions.systemSettings")
            Text("Landed on the Settings home page? Look under Apps → Nekko Agent.")
                .font(.caption).foregroundStyle(palette.inkFaint)
        }
        .padding(.horizontal, 4)
    }
}
