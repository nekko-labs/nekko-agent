import ActivityKit
import AppIntents
import NekkoProtocol
import SwiftUI
import WidgetKit

@main
struct NekkoWidgets: WidgetBundle {
    var body: some Widget {
        NekkoCardLiveActivity()
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
        StaticControlConfiguration(kind: "dev.nekkolabs.nekkoagent.new-chat") {
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

/// The one card for all of the computer's chats. The Lock Screen and the
/// expanded Dynamic Island are both `LiveCardView`.
struct NekkoCardLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NekkoCardAttributes.self) { context in
            LiveCardView(state: context.state, level: context.attributes.level, interactive: true)
                .padding(14)
                .activityBackgroundTint(LiveCardView.background.opacity(0.92))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(chatURL(context.state.focusId))
        } dynamicIsland: { context in
            let urgent = context.state.chats.first?.state ?? .working
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    LiveCardView(state: context.state, level: context.attributes.level, interactive: true)
                }
            } compactLeading: {
                PixelCat().frame(width: 22, height: 22)
            } compactTrailing: {
                HStack(spacing: 3) {
                    LiveStatusGlyph(state: urgent, size: 14)
                    Text("\(context.state.chats.count + context.state.more)").font(.caption2.weight(.semibold)).monospacedDigit()
                }
            } minimal: {
                LiveStatusGlyph(state: urgent, size: 14)
            }
            .widgetURL(chatURL(context.state.focusId))
            .keylineTint(urgent.tint)
        }
    }

    private func chatURL(_ id: String?) -> URL? {
        id.flatMap { URL(string: "nekko-agent://chat/\($0)") }
    }
}
