import NekkoKit
import NekkoProtocol
import SwiftUI

/// The agent's plan as the desktop draws it (`PlanSheet.tsx`): a sheet tucked
/// behind the composer's top edge, with curved shoulders into it and a touch
/// of accent in its surface, so no line divides them.
///
/// Folded (the default) it is one or two lines: the step being worked (its
/// mark, loop kind, title, pass and "2 of 4") and a row of chips for it.
/// Tapping it opens the whole plan, every step with its detail and chips;
/// finished steps squeeze to their title and open when tapped (the desktop
/// opens them on hover). Chips are placed by the app, not the model:
/// sub-agents, verification, PRs and task links.
struct PlanSheet: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open = false
    /// Squeezed steps the user tapped open.
    @State private var unsqueezed: Set<String> = []
    @State private var prs: [PullRequest] = []
    @State private var risen = false

    /// How far the sheet runs under the composer, and how far its shoulders reach out.
    static let tuck: CGFloat = 12
    private static let shoulder: CGFloat = 12

    /// The plan the sheet shows for this chat (`sheetPlan`): empty when there is none, and then no sheet.
    @MainActor static func plan(_ chat: ChatModel, _ store: ComputersStore) -> [PlanStep] {
        let claudeCode = store.providers.first { $0.id == chat.session?.providerId }?.kind == AgentPlan.claudeCodeKind
        return AgentPlan.sheet(chat.session, claudeCode: claudeCode, working: chat.running) ?? []
    }

    var body: some View {
        let plan = Self.plan(chat, store)
        Group {
            if let current = AgentPlan.current(plan), chat.session != nil {
                let links = AgentPlan.links(chat.session?.messages ?? [], plan: plan, prs: Set(prs.map(\.url)), children: chat.children)
                let paused = AgentPlan.paused(chat.session?.messages ?? [], running: chat.running)
                VStack(alignment: .leading, spacing: 0) {
                    if open { whole(plan, links: links, paused: paused) } else { folded(plan, current: current, links: links, paused: paused) }
                }
                .padding(.horizontal, Self.shoulder + 12).padding(.top, 8).padding(.bottom, Self.tuck + 8)
                .background {
                    let shape = PlanSheetShape(shoulder: Self.shoulder, tuck: Self.tuck)
                    ZStack { shape.fill(palette.surface2); shape.fill(palette.accent.opacity(0.1)) }
                }
                .padding(.horizontal, 4)
                // It rises out from under the composer when it first appears (160 ms, none with Reduce Motion).
                .offset(y: risen || reduceMotion ? 0 : 24)
                .onAppear { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { risen = true } }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Agent plan")
                .accessibilityIdentifier("chat.planSheet")
            }
        }
        .task(id: chat.session?.updatedAt) {
            if let list = try? await chat.pullRequests() { prs = list }
        }
    }

    // MARK: Folded and open

    private func folded(_ plan: [PlanStep], current: PlanStep, links: [String: PlanStepLinks], paused: Bool) -> some View {
        let own = links[current.id]
        // The current step's PRs, else the newest PR the chat opened, so a finished plan still shows where it landed.
        let shownPrs = own?.prs.isEmpty == false ? own!.prs : Array(plan.compactMap { links[$0.id]?.prs }.flatMap { $0 }.suffix(1))
        // The step's own task links, else the chat's (the first step's), which say what this work is for.
        let projects = own?.projects.isEmpty == false ? own!.projects : (plan.first.flatMap { links[$0.id]?.projects } ?? [])
        let position = (plan.firstIndex { $0.id == current.id } ?? 0) + 1
        return VStack(alignment: .leading, spacing: 4) {
            Button { toggle(true) } label: {
                HStack(spacing: 8) {
                    PlanStepMark(status: current.status, paused: paused)
                    if let kind = current.kind { KindLabel(kind: kind, current: current.status == .active) }
                    Text(current.title).font(.footnote).lineLimit(1)
                        .foregroundStyle(current.status == .done ? palette.inkSoft : palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    PassLabel(step: current)
                    Text("\(position) of \(plan.count)").font(.caption2.monospacedDigit()).foregroundStyle(palette.inkFaint)
                    Image(systemName: "chevron.up").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
                }
                .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Plan, step \(position) of \(plan.count): \(current.title)")
            .accessibilityHint("Shows the whole plan")
            .accessibilityIdentifier("chat.planFolded")
            let kids = chat.children
            if !kids.isEmpty || current.verification != nil || !shownPrs.isEmpty || !projects.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if !kids.isEmpty { SubagentSummary(children: kids) }
                        if let v = current.verification { verificationChip(v) }
                        ForEach(shownPrs, id: \.self) { prChip($0) }
                        ForEach(projects, id: \.url) { projectChip($0) }
                    }
                }
                .padding(.leading, 20)
            }
        }
    }

    private func whole(_ plan: [PlanStep], links: [String: PlanStepLinks], paused: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { toggle(false) } label: {
                HStack(spacing: 8) {
                    Text("Plan").fontWeight(.semibold).foregroundStyle(palette.inkSoft)
                    Text("\(AgentPlan.finished(plan)) of \(plan.count) done").monospacedDigit()
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").fontWeight(.semibold)
                }
                .font(.caption2).foregroundStyle(palette.inkFaint)
                .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Plan, \(AgentPlan.finished(plan)) of \(plan.count) done")
            .accessibilityHint("Folds the plan")
            .accessibilityIdentifier("chat.planOpen")
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(plan) { step in row(step, links: links[step.id], paused: paused) }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 280)
        }
    }

    private func row(_ step: PlanStep, links own: PlanStepLinks?, paused: Bool) -> some View {
        let kids = (own?.subagents ?? []).compactMap { id in chat.children.first { $0.id == id } }
        let chips = own?.prs.isEmpty == false || own?.projects.isEmpty == false || !kids.isEmpty || step.verification != nil
        let more = step.detail != nil || chips
        let shown = !step.squeezed || unsqueezed.contains(step.id)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            PlanStepMark(status: step.status, paused: paused)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    // The loop kind sits in a fixed column, as on the desktop.
                    Group {
                        if let kind = step.kind { KindLabel(kind: kind, current: step.status == .active) } else { Color.clear }
                    }
                    .frame(width: 46, alignment: .leading)
                    Text(step.title).font(.footnote).lineLimit(1)
                        .strikethrough(step.status == .skipped)
                        .foregroundStyle(step.squeezed ? palette.inkSoft : palette.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    PassLabel(step: step)
                }
                if more && shown {
                    VStack(alignment: .leading, spacing: 2) {
                        if let detail = step.detail {
                            Text(detail).font(.caption).foregroundStyle(palette.inkFaint).lineLimit(1)
                        }
                        if chips {
                            FlowChips {
                                ForEach(own?.projects ?? [], id: \.url) { projectChip($0) }
                                ForEach(kids) { subagentChip($0) }
                                if let v = step.verification { verificationChip(v) }
                                ForEach(own?.prs ?? [], id: \.self) { prChip($0) }
                            }
                        }
                    }
                    .padding(.leading, 54)
                    .transition(.opacity)
                }
            }
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            guard step.squeezed, more else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.12)) {
                if unsqueezed.contains(step.id) { unsqueezed.remove(step.id) } else { unsqueezed.insert(step.id) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.planStep.\(step.id)")
    }

    private func toggle(_ to: Bool) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { open = to }
    }

    // MARK: Chips

    private func chip<Content: View>(_ action: (() -> Void)?, @ViewBuilder _ label: () -> Content) -> some View {
        let body = HStack(spacing: 4) { label() }
            .font(.caption2).lineLimit(1).foregroundStyle(palette.inkSoft)
            .padding(.horizontal, 8).frame(height: 22)
            .background(palette.ink.opacity(0.07), in: Capsule())
            .frame(minHeight: 30).contentShape(Rectangle())
        return Group {
            if let action { Button(action: action) { body }.buttonStyle(.plain) } else { body }
        }
    }

    private func dot(_ tone: Color) -> some View { Circle().fill(tone).frame(width: 6, height: 6) }

    private func prChip(_ url: String) -> some View {
        let pr = prs.first { $0.url == url }
        let (text, tone) = prLabel(url, pr)
        return chip({ if let u = URL(string: url) { openURL(u) } }) { dot(tone); Text(text) }
            .accessibilityLabel("Pull request \(text)")
    }

    /// The desktop's words (`prChipLabel`): number, state, and CI.
    private func prLabel(_ url: String, _ pr: PullRequest?) -> (String, Color) {
        let number = pr.map { String($0.number) } ?? url.split(separator: "/").last.map(String.init) ?? ""
        guard let pr else { return ("#\(number)", palette.inkFaint) }
        switch pr.state {
        case .merged: return ("#\(number) · Merged", palette.accent)
        case .closed: return ("#\(number) · Closed", palette.inkFaint)
        case .open: break
        }
        let (ci, tone): (String, Color) = switch pr.checks {
        case .failing: ("CI failing", palette.danger)
        case .passing: ("CI passing", palette.success)
        case .pending: ("CI running", palette.warning)
        case .none: ("No CI", palette.inkFaint)
        }
        return ("#\(number) · \(pr.isDraft ? "Draft" : "Open") · \(ci)", tone)
    }

    private func verificationChip(_ v: PlanStep.Verification) -> some View {
        let tone: Color = switch v.status {
        case .passed: palette.success
        case .failed: palette.danger
        case .blocked: palette.warning
        case .active: palette.accent
        case .pending, .unknown: palette.inkFaint
        }
        let evidence = v.safeEvidence
        return chip(evidence.map { url in { openURL(url) } }) { dot(tone); Text(v.label) }
            .accessibilityLabel("\(v.label), agent-reported")
    }

    private func projectChip(_ link: ProjectLink) -> some View {
        chip({ if let u = URL(string: link.url) { openURL(u) } }) {
            Image(systemName: "tag").font(.caption2).accessibilityHidden(true)
            Text(link.label)
        }
    }

    private func subagentChip(_ child: SessionSummary) -> some View {
        chip({ app.openChat = child.id }) {
            Image(systemName: "cpu").font(.caption2).accessibilityHidden(true)
            Text(child.title.isEmpty ? "Sub-agent" : child.title)
            Image(systemName: child.running ? "paperplane.fill" : "checkmark")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(child.running ? palette.success : palette.inkFaint)
                .accessibilityLabel(child.running ? "Running" : "Done")
        }
    }
}

/// The step's status mark: a check when done, a sun-burst while worked (two
/// bars when paused), a ring ahead, a struck ring when skipped. Not animated.
private struct PlanStepMark: View {
    let status: PlanStep.Status
    let paused: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch status {
            case .done: Image(systemName: "checkmark").foregroundStyle(palette.success)
            case .active: Image(systemName: paused ? "pause" : "sun.max").foregroundStyle(palette.accent)
            case .skipped: Image(systemName: "circle.slash").foregroundStyle(palette.inkFaint)
            case .pending: Image(systemName: "circle").foregroundStyle(palette.inkFaint)
            }
        }
        .font(.system(size: 11, weight: .semibold))
        .frame(width: 12, height: 12)
        .accessibilityLabel(status == .active ? (paused ? "Paused" : "Working") : status == .done ? "Done" : status == .skipped ? "Skipped" : "Pending")
    }
}

/// The step's place in the loop: a small word before its title, in the accent while worked.
private struct KindLabel: View {
    let kind: PlanStep.Kind
    let current: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Text(kind.label).font(.caption.weight(.medium)).foregroundStyle(current ? palette.accent : palette.inkSoft).fixedSize()
    }
}

/// "Pass 2": Verify sent the work back to this step.
private struct PassLabel: View {
    let step: PlanStep
    @Environment(\.palette) private var palette

    var body: some View {
        if let pass = step.pass, pass >= 2 {
            Label("Pass \(pass)", systemImage: "arrow.clockwise").labelStyle(.titleAndIcon)
                .font(.caption2).foregroundStyle(palette.inkFaint).fixedSize()
                .accessibilityLabel("Pass \(pass): a later check sent the work back here")
        }
    }
}

/// Folded, the sub-agents are one chip: how many run and how many are done.
private struct SubagentSummary: View {
    let children: [SessionSummary]
    @Environment(\.palette) private var palette

    var body: some View {
        let running = children.filter(\.running).count
        let done = children.count - running
        HStack(spacing: 4) {
            Text("Sub-agents")
            if running > 0 {
                Text("\(running)").fontWeight(.semibold).foregroundStyle(palette.ink)
                Image(systemName: "paperplane.fill").font(.system(size: 9, weight: .semibold)).foregroundStyle(palette.success)
            }
            if done > 0 {
                Text("\(done)").fontWeight(.semibold).foregroundStyle(palette.ink)
                Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(palette.inkFaint)
            }
        }
        .font(.caption2).lineLimit(1).foregroundStyle(palette.inkSoft)
        .padding(.horizontal, 8).frame(height: 22)
        .background(palette.ink.opacity(0.07), in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Sub-agents: \(running) running, \(done) done")
    }
}

/// Chips that wrap onto further lines in the open plan.
private struct FlowChips<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        WrapLayout(spacing: 8) { content }
    }
}

private struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { y += line + 2; x = 0; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { y += line + 2; x = bounds.minX; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(s.width, bounds.width), height: s.height))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// The sheet's outline: rounded on top, and where its sides meet the
/// composer (`tuck` above its bottom) they curve out into it, the desktop's
/// shoulders. The part below that runs under the composer.
struct PlanSheetShape: Shape {
    var shoulder: CGFloat
    var tuck: CGFloat
    var radius: CGFloat = 14

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let edge = rect.maxY - tuck
        let left = rect.minX + shoulder, right = rect.maxX - shoulder
        p.move(to: CGPoint(x: rect.minX, y: edge))
        p.addQuadCurve(to: CGPoint(x: left, y: edge - shoulder), control: CGPoint(x: left, y: edge))
        p.addLine(to: CGPoint(x: left, y: rect.minY + radius))
        p.addQuadCurve(to: CGPoint(x: left + radius, y: rect.minY), control: CGPoint(x: left, y: rect.minY))
        p.addLine(to: CGPoint(x: right - radius, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: right, y: rect.minY + radius), control: CGPoint(x: right, y: rect.minY))
        p.addLine(to: CGPoint(x: right, y: edge - shoulder))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: edge), control: CGPoint(x: right, y: edge))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}
