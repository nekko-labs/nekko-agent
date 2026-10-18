import SwiftUI
import WidgetKit

/// The watch face complication: the Needs-you count from the snapshot the
/// watch app keeps (counts and the computer's name, as the iPhone sent them).
/// Tapping it opens the watch app.
@main
struct NekkoWatchWidgets: WidgetBundle {
    var body: some Widget { WatchStatusComplication() }
}

struct WatchStatusComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WatchStatus.kind, provider: WatchStatusProvider()) { entry in
            WatchComplicationView(snapshot: entry.snapshot, family: entry.family)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("Needs you")
        .description("How many chats on your computer need you.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
    }
}

struct WatchStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: StatusSnapshot
    let family: WidgetFamily
}

struct WatchStatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchStatusEntry {
        WatchStatusEntry(date: .now, snapshot: StatusSnapshot(computer: "Mac", online: true, needsYou: 1, running: 2, at: .now), family: context.family)
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchStatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : WatchStatusEntry(date: .now, snapshot: WatchStatus.load(), family: context.family))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchStatusEntry>) -> Void) {
        // The watch app reloads this timeline when the iPhone sends new counts.
        completion(Timeline(entries: [WatchStatusEntry(date: .now, snapshot: WatchStatus.load(), family: context.family)], policy: .never))
    }
}

struct WatchComplicationView: View {
    let snapshot: StatusSnapshot
    let family: WidgetFamily

    private var count: Int { snapshot.needsYou > 0 ? snapshot.needsYou : snapshot.running }
    private var symbol: String { snapshot.needsYou > 0 ? "hand.raised.fill" : "cat" }

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: symbol).font(.caption2)
                    Text("\(count)").font(.headline.monospacedDigit())
                }
            }
            .accessibilityLabel(snapshot.headline)
        case .accessoryCorner:
            Image(systemName: symbol)
                .font(.title3)
                .widgetLabel(snapshot.headline)
                .accessibilityLabel(snapshot.headline)
        case .accessoryInline:
            Label(snapshot.headline, systemImage: symbol)
        default:
            VStack(alignment: .leading, spacing: 2) {
                Text("Nekko Agent").font(.caption2.weight(.semibold)).widgetAccentable()
                Text(snapshot.headline).font(.headline)
                if let computer = snapshot.computer { Text(computer).font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
