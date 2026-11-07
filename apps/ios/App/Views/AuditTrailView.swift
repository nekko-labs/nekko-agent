import NekkoKit
import NekkoProtocol
import SwiftUI

/// A chat's audit trail: every turn, tool call and approval, and who answered,
/// read from the computer (`audit:read`). Value-free by design: it never shows
/// what the agent read or sent. The desktop's `AuditTrail.tsx`.
struct AuditTrailView: View {
    let load: () async throws -> [AuditEvent]
    var incognito = false
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var trail: [AuditEvent]?
    @State private var error: String?
    @State private var onlyDecisions = false

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView("Couldn’t read the audit trail", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if let trail {
                    if trail.isEmpty {
                        Group {
                            if incognito {
                                ContentUnavailableView("No audit trail", systemImage: "checkmark.shield",
                                                       description: Text("Incognito chats keep no audit trail."))
                            } else {
                                ContentUnavailableView("Nothing recorded yet", systemImage: "checkmark.shield",
                                                       description: Text("Turns, tool calls and approvals appear here as the agent works."))
                            }
                        }
                        .accessibilityIdentifier("audit.empty")
                    } else {
                        list(trail)
                    }
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(palette.paper)
            .navigationTitle("Audit trail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    Button { Task { await read() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                }
            }
            .task { await read() }
        }
    }

    private func list(_ trail: [AuditEvent]) -> some View {
        let decisions = trail.filter(\.isDecision).count
        let turns = AuditTurn.group(trail)
            .map { t -> AuditTurn in var t = t; if onlyDecisions { t.events = t.events.filter(\.isDecision) }; return t }
            .filter { !onlyDecisions || !$0.events.isEmpty }
            .reversed()
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("What the agent did in this chat and who allowed it. It never holds what the agent read or sent, and it is deleted with the chat.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                Picker("Show", selection: $onlyDecisions) {
                    Text("Everything").tag(false)
                    (decisions > 0 ? Text("Approvals (\(decisions))") : Text("Approvals")).tag(true)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("audit.filter")
                if turns.isEmpty {
                    Text("No approvals in this chat.").font(.footnote).foregroundStyle(palette.inkFaint)
                }
                ForEach(Array(turns)) { turn in TurnSection(turn: turn) }
            }
            .padding(16)
        }
        .accessibilityIdentifier("audit.trail")
    }

    private func read() async {
        do {
            trail = try await load()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct TurnSection: View {
    let turn: AuditTurn
    @Environment(\.palette) private var palette

    var body: some View {
        let head = turn.start.map(AuditLine.of)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(head?.text ?? String(localized: "Turn")).font(.footnote.weight(.semibold)).foregroundStyle(palette.ink)
                if let d = head?.detail { Text(d).font(.caption).foregroundStyle(palette.inkFaint).lineLimit(1) }
                Spacer(minLength: 4)
                if let s = turn.start { Text(time(s.at)).font(.caption.monospacedDigit()).foregroundStyle(palette.inkFaint) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(turn.events) { e in EventRow(event: e) }
            }
            .padding(.leading, 12)
            .overlay(alignment: .leading) { Rectangle().fill(palette.line).frame(width: 1) }
        }
    }
}

private struct EventRow: View {
    let event: AuditEvent
    @Environment(\.palette) private var palette

    var body: some View {
        let line = AuditLine.of(event)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(color(line.tone)).frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(line.text).font(.caption).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                if let d = line.detail {
                    Text(d).font(.caption).foregroundStyle(palette.inkFaint).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(time(event.at)).font(.caption.monospacedDigit()).foregroundStyle(palette.inkFaint)
        }
        .accessibilityElement(children: .combine)
    }

    private func color(_ tone: AuditLine.Tone) -> Color {
        switch tone {
        case .neutral: return palette.inkFaint
        case .good: return palette.success
        case .warn: return palette.warning
        case .bad: return palette.danger
        }
    }
}

private func time(_ at: Int64) -> String {
    Date(timeIntervalSince1970: Double(at) / 1000).formatted(date: .omitted, time: .standard)
}
