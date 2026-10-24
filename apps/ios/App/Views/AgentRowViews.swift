import NekkoKit
import NekkoProtocol
import SwiftUI

/// The rows for what the agent is doing, drawn as the desktop draws them: no
/// fill, no stroke, one line each with a mark in a fixed box on the left, a
/// label, and a quiet chip on the right; a tool's output opens underneath.
/// Only the user's bubble, the code well and an approval or question card keep
/// an edge in a chat.

/// The desktop's running dots: three dots in a fixed box, so the text beside
/// them never moves as the third lands.
struct RunningDots: View {
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(palette.running).frame(width: 3.5, height: 3.5)
                    .opacity(reduceMotion ? 0.8 : (on ? 1 : 0.25))
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(Double(i) * 0.2), value: on)
            }
        }
        .frame(width: 16, height: 16)
        .onAppear { on = true }
        .accessibilityHidden(true)
    }
}

/// A 11 pt chip with 4 pt corners and a 1 pt line, no fill (the desktop's one chip rule).
struct RowChip: View {
    let text: String
    var tone: AgentRows.Tone = .normal
    var accent = false
    @Environment(\.palette) private var palette

    var body: some View {
        let color: Color = accent ? palette.accent : {
            switch tone {
            case .normal, .quiet: return palette.inkFaint
            case .warn: return palette.warning
            case .danger: return palette.danger
            }
        }()
        Text(text).font(.caption2.monospacedDigit()).foregroundStyle(color).lineLimit(1)
            .padding(.horizontal, tone == .quiet ? 0 : 6).padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(tone == .quiet ? .clear : color.opacity(0.7), lineWidth: 1))
    }
}

/// The status mark of a step, in the same 16 pt box as the dots.
struct StepMark: View {
    let status: ToolStatus
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            switch status {
            case .running: RunningDots()
            case .waiting: Image(systemName: "hand.raised.fill").foregroundStyle(palette.warning)
            case .ok: Image(systemName: "checkmark").foregroundStyle(palette.success)
            case .error: Image(systemName: "xmark").foregroundStyle(palette.danger)
            }
        }
        .font(.caption.weight(.semibold))
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }
}

/// One tool call: its mark, its label and, when it has output, a chevron that opens the code well.
struct ToolRow: View {
    let label: String
    let status: ToolStatus
    let output: String?
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if output != nil { withAnimation(.snappy) { expanded.toggle() } }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    StepMark(status: status)
                    Text(label).font(.footnote.monospaced()).foregroundStyle(palette.inkSoft).lineLimit(expanded ? nil : 1)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    if output != nil { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(palette.inkFaint) }
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(label), \(statusName(status))")
            .accessibilityValue(output == nil ? "" : (expanded ? "Output shown" : "Output hidden"))
            .accessibilityHint(output == nil ? "" : "Shows or hides the output")
            if expanded, let output { OutputWell(output: output) }
        }
    }

    private func statusName(_ s: ToolStatus) -> String {
        switch s {
        case .running: return String(localized: "running")
        case .waiting: return String(localized: "waiting for you")
        case .ok: return String(localized: "done")
        case .error: return String(localized: "failed")
        }
    }
}

/// A tool's output as a code well under its row, with the phone's notes under it.
struct OutputWell: View {
    let output: String
    @Environment(\.palette) private var palette

    var body: some View {
        let split = Transcript.splitNotes(output)
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(split.0.isEmpty ? "(no output)" : split.0).font(.caption.monospaced()).foregroundStyle(palette.ink)
                    .textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(10)
            }
            .frame(maxHeight: 280)
            .background(palette.code, in: RoundedRectangle(cornerRadius: 8))
            ForEach(split.1, id: \.self) { Text($0).font(.caption2).foregroundStyle(palette.inkFaint) }
        }
        .padding(.leading, 24)
    }
}

/// An armed watch: binoculars, what it watches and what fires it, a *then ·*
/// line, and a live chip from the computer's `session:watches`.
struct WatchRow: View {
    let input: [String: JSONValue]
    let status: ToolStatus
    let output: String?
    let watches: [AgentWatch]
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        let failed = status == .error
        let call = AgentRows.parseWatch(input, output: output, failed: failed)
        let view = call.id.flatMap { id in watches.first { $0.id == id } }
        let then = AgentRows.thenSummary(call.prompt)
        VStack(alignment: .leading, spacing: 2) {
            Button {
                if output != nil { withAnimation(.snappy) { expanded.toggle() } }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    if status == .running { RunningDots() } else {
                        Image(systemName: "binoculars").font(.caption.weight(.semibold)).foregroundStyle(failed ? palette.danger : palette.accent)
                            .frame(width: 16, height: 16).accessibilityHidden(true)
                    }
                    Text(AgentRows.watchHeadline(call, failed: failed ? output : nil))
                        .font(.footnote.weight(.medium)).foregroundStyle(palette.inkSoft).lineLimit(1)
                    Spacer(minLength: 4)
                    if call.action == .create, !failed { WatchClockChip(call: call, view: view) }
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(AgentRows.watchHeadline(call, failed: failed ? output : nil))
            if !then.isEmpty, call.action == .create {
                ThenLine(text: then)
            }
            if expanded, let output { OutputWell(output: output) }
        }
    }
}

/// The subline under a watch: what the agent does when it wakes.
struct ThenLine: View {
    let text: String
    @Environment(\.palette) private var palette

    var body: some View {
        (Text("then").foregroundStyle(palette.inkSoft) + Text(" · \(text)").foregroundStyle(palette.inkFaint))
            .font(.caption).lineLimit(2).padding(.leading, 24)
    }
}

/// The watch's timer: ticks once a second while it is on screen and counting.
struct WatchClockChip: View {
    let call: AgentRows.WatchCall
    let view: AgentWatch?

    var body: some View {
        let ticking = AgentRows.watchClock(call, view: view, now: Int64(Date().timeIntervalSince1970 * 1000))?.ticking ?? false
        TimelineView(.periodic(from: .now, by: ticking ? 1 : 3600)) { context in
            if let clock = AgentRows.watchClock(call, view: view, now: Int64(context.date.timeIntervalSince1970 * 1000)) {
                RowChip(text: clock.text, tone: clock.tone)
                    .accessibilityLabel(clock.detail)
            }
        }
    }
}

/// The wake-up the computer sent when a watch fired, as a step of the run
/// rather than a bubble from the user; opens to the whole text.
struct WatchWakeRow: View {
    let wake: AgentRows.Wake
    let content: String
    let at: Int64?
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        let then = AgentRows.thenSummary(wake.prompt)
        VStack(alignment: .leading, spacing: 2) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: "bolt.fill").font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                        .frame(width: 16, height: 16).accessibilityHidden(true)
                    (Text("Watch triggered").fontWeight(.medium) + Text(" · \(wake.trigger)") + Text(wake.detail.isEmpty ? "" : " (\(wake.detail))"))
                        .font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(1)
                    Spacer(minLength: 4)
                    if let at, at > 0 {
                        Text(Date(timeIntervalSince1970: Double(at) / 1000), format: .dateTime.hour().minute())
                            .font(.caption2.monospacedDigit()).foregroundStyle(palette.inkFaint)
                    }
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Watch triggered, \(wake.trigger). \(wake.detail)")
            .accessibilityHint("Shows or hides the wake-up text")
            if !then.isEmpty { ThenLine(text: then) }
            if expanded {
                Text(content).font(.caption.monospaced()).foregroundStyle(palette.inkFaint).textSelection(.enabled)
                    .padding(.leading, 24).frame(maxHeight: 320)
            }
        }
    }
}

/// One delegation's child: its mark, its title and what it is doing, its model as a quiet chip.
struct SubagentRow: View {
    let input: [String: JSONValue]
    let status: ToolStatus
    let output: String?
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var expanded = false

    var body: some View {
        let child = AgentRows.subagentChild(input, children: chat.children)
        let state = AgentRows.subagentStatus(output: output, failed: status == .error,
                                             activity: child.flatMap { store.activity[$0.id] }, parentRunning: chat.running)
        let model = AgentRows.subagentModel(input, child: child, children: chat.children, inherited: chat.modelId)
        let title = AgentRows.subagentTitle(input)
        VStack(alignment: .leading, spacing: 4) {
            Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                HStack(alignment: .center, spacing: 8) {
                    mark(state)
                    (Text(title).fontWeight(.semibold).foregroundStyle(palette.ink) + Text(" · \(detail(state))").foregroundStyle(palette.inkSoft))
                        .font(.footnote).lineLimit(1)
                    Spacer(minLength: 4)
                    if let model { RowChip(text: AgentRows.shortModelName(model.id), tone: .quiet).accessibilityLabel("Model \(model.id)") }
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Subagent \(title), \(state.rawValue). \(detail(state))")
            .accessibilityHint("Shows or hides the task and result")
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    let task = AgentRows.subagentTask(input)
                    if !task.isEmpty { Text(task).font(.caption).foregroundStyle(palette.inkSoft).textSelection(.enabled) }
                    if let output { OutputWell(output: output).padding(.leading, -24) }
                }
                .padding(.leading, 24)
            }
        }
    }

    @ViewBuilder private func mark(_ s: AgentRows.SubagentStatus) -> some View {
        Group {
            switch s {
            case .working: RunningDots()
            case .waiting: Image(systemName: "hand.raised.fill").foregroundStyle(palette.warning)
            case .completed: Image(systemName: "checkmark").foregroundStyle(palette.success)
            case .failed: Image(systemName: "xmark").foregroundStyle(palette.danger)
            case .stopped: Image(systemName: "pause").foregroundStyle(palette.inkFaint)
            }
        }
        .font(.caption.weight(.semibold)).frame(width: 16, height: 16).accessibilityHidden(true)
    }

    private func detail(_ s: AgentRows.SubagentStatus) -> String {
        switch s {
        case .working: return String(localized: "working")
        case .waiting: return output == nil ? String(localized: "waiting") : String(localized: "waiting for you")
        case .completed: return String(localized: "done")
        case .failed: return String(localized: "failed")
        case .stopped: return String(localized: "stopped")
        }
    }
}

/// A run of delegations: a header with the count and the parent's model, then
/// each child indented on a hairline, as the desktop's step list.
struct SubagentGroup: View {
    let blocks: [Block]
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        let states = blocks.map { b -> AgentRows.SubagentStatus in
            guard case .tool(_, _, _, let status, let output, let input) = b else { return .completed }
            let child = AgentRows.subagentChild(input, children: chat.children)
            return AgentRows.subagentStatus(output: output, failed: status == .error, activity: child.flatMap { store.activity[$0.id] }, parentRunning: chat.running)
        }
        let working = states.filter { $0 == .working }.count
        let waiting = states.filter { $0 == .waiting }.count
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: 8) {
                if working > 0 { RunningDots() } else {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                        .frame(width: 16, height: 16).accessibilityHidden(true)
                }
                Text(headline(count: blocks.count, working: working, waiting: waiting))
                    .font(.footnote.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                Spacer(minLength: 4)
                if let m = chat.modelId { RowChip(text: AgentRows.shortModelName(m), accent: true).accessibilityLabel("Model \(m)") }
            }
            .frame(minHeight: 30)
            .accessibilityElement(children: .combine)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(blocks) { b in
                    if case .tool(_, _, _, let status, let output, let input) = b {
                        SubagentRow(input: input, status: status, output: output, chat: chat).id(b.id)
                    }
                }
            }
            .padding(.leading, 24)
            .overlay(alignment: .leading) {
                Rectangle().fill(palette.line).frame(width: 1.5).padding(.leading, 7).padding(.vertical, 4)
            }
        }
    }

    private func headline(count: Int, working: Int, waiting: Int) -> String {
        let n = count == 1 ? String(localized: "1 subagent") : String(localized: "\(count) subagents")
        if working > 0 { return "\(n) · \(working) working" }
        if waiting > 0 { return "\(n) · \(waiting) waiting" }
        return "\(n) · done"
    }
}
