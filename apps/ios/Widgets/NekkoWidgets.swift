import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct NekkoWidgets: WidgetBundle {
    var body: some Widget {
        AgentRunLiveActivity()
        StatusWidget()
        if #available(iOS 18.0, *) { NewChatControl() }
    }
}

/// Control Center, the Lock Screen and the Action button (iOS 18): one tap opens
/// New chat on the active computer. It only opens the app, which still asks for
/// Face ID when the app lock is on; nothing is sent.
@available(iOS 18.0, *)
struct NewChatControl: ControlWidget {
    static let url = URL(string: "nekko-agent://new")!

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.nekko.native.ios.new-chat") {
            ControlWidgetButton(action: OpenURLIntent(Self.url)) {
                Label("New chat", systemImage: "square.and.pencil")
            }
        }
        .displayName("New chat")
        .description("Start a chat on your computer.")
    }
}

/// Home Screen and Lock Screen: how many chats need you, from the snapshot the
/// app keeps in the App Group. It is only as fresh as the app's last look.
struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: StatusSnapshot.kind, provider: StatusProvider()) { entry in
            StatusWidgetView(snapshot: entry.snapshot, family: entry.family)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Needs you")
        .description("Chats on your computer that are waiting on you or working.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

struct StatusEntry: TimelineEntry {
    let date: Date
    let snapshot: StatusSnapshot
    let family: WidgetFamily
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(date: .now, snapshot: StatusSnapshot(computer: "Mac", online: true, needsYou: 1, running: 2, at: .now), family: context.family)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StatusEntry(date: .now, snapshot: .load(), family: context.family))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        // The app reloads this timeline when the counts change; nothing to poll.
        completion(Timeline(entries: [StatusEntry(date: .now, snapshot: .load(), family: context.family)], policy: .never))
    }
}

/// A chat running on the computer: what it's doing, how long, and — when it
/// waits on you — Allow / Deny right there. The buttons run
/// `AllowToolIntent` / `AnswerApprovalIntent` in the app's process, which holds the relay.
struct AgentRunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentRunAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.65))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "nekko-agent://chat/\(context.attributes.sessionId)"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    PhaseIcon(phase: context.state.phase).font(.title3).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.phase == .running && context.state.hasStart {
                        Text(context.state.startedAt, style: .timer).monospacedDigit().font(.caption).frame(maxWidth: 56)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.chatTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(context.state.displayStep).font(.caption.monospaced()).lineLimit(2).foregroundStyle(.secondary)
                        Buttons(context: context)
                    }
                }
            } compactLeading: {
                PhaseIcon(phase: context.state.phase)
            } compactTrailing: {
                if context.state.phase == .running && context.state.hasStart {
                    Text(context.state.startedAt, style: .timer).monospacedDigit().frame(maxWidth: 44)
                } else {
                    Text(shortLabel(context.state.phase)).font(.caption2.weight(.semibold))
                }
            } minimal: {
                PhaseIcon(phase: context.state.phase)
            }
            .widgetURL(URL(string: "nekko-agent://chat/\(context.attributes.sessionId)"))
            .keylineTint(color(context.state.phase))
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<AgentRunAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                PhaseIcon(phase: context.state.phase)
                Text(context.attributes.chatTitle).font(.headline).lineLimit(1)
                Spacer()
                if context.state.phase == .running && context.state.hasStart {
                    Text(context.state.startedAt, style: .timer).monospacedDigit().font(.caption).foregroundStyle(.secondary).frame(maxWidth: 60)
                }
            }
            Text(context.state.displayStep).font(.subheadline.monospaced()).lineLimit(2)
            HStack {
                Text("\(context.attributes.computerName) · ^[\(context.state.steps) step](inflect: true)").font(.caption2).foregroundStyle(.secondary)
                Spacer()
            }
            Buttons(context: context)
        }
        .padding(14)
        .foregroundStyle(.white)
    }
}

private struct Buttons: View {
    let context: ActivityViewContext<AgentRunAttributes>

    var body: some View {
        switch context.state.phase {
        case .approval:
            if let callId = context.state.callId {
                HStack {
                    Button(intent: AnswerApprovalIntent(sessionId: context.attributes.sessionId, callId: callId, allow: false)) {
                        Text("Deny").frame(maxWidth: .infinity)
                    }.tint(.red)
                    Button(intent: AllowToolIntent(sessionId: context.attributes.sessionId, callId: callId)) {
                        Text("Allow").frame(maxWidth: .infinity)
                    }.tint(.green)
                }
                .buttonStyle(.borderedProminent)
            }
        case .running:
            Button(intent: StopRunIntent(sessionId: context.attributes.sessionId)) {
                Label("Stop", systemImage: "stop.fill").font(.caption)
            }
            .buttonStyle(.bordered)
            .tint(.white)
        default:
            EmptyView()
        }
    }
}

private struct PhaseIcon: View {
    let phase: AgentRunAttributes.Phase

    var body: some View {
        Image(systemName: symbol).foregroundStyle(color(phase)).accessibilityLabel(label)
    }

    private var label: String {
        switch phase {
        case .running: return "Working"
        case .approval: return "Waiting for your approval"
        case .question: return "Waiting for your answer"
        case .done: return "Finished"
        case .failed: return "Failed"
        }
    }

    private var symbol: String {
        switch phase {
        case .running: return "sparkles"
        case .approval: return "hand.raised.fill"
        case .question: return "questionmark.bubble.fill"
        case .done: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }
}

private func color(_ phase: AgentRunAttributes.Phase) -> Color {
    switch phase {
    case .running: return Color(red: 0.55, green: 0.49, blue: 1)
    case .approval, .question: return .orange
    case .done: return .green
    case .failed: return .red
    }
}

private func shortLabel(_ phase: AgentRunAttributes.Phase) -> String {
    switch phase {
    case .running: return ""
    case .approval: return "Approve?"
    case .question: return "Asks"
    case .done: return "Done"
    case .failed: return "Error"
    }
}
