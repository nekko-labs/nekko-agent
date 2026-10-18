import SwiftUI
import WidgetKit

/// The widget's face, shared so the app's tests can render it.
struct StatusWidgetView: View {
    let snapshot: StatusSnapshot
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: snapshot.needsYou > 0 ? "hand.raised.fill" : "cat")
                        .font(.caption)
                    Text("\(snapshot.needsYou > 0 ? snapshot.needsYou : snapshot.running)")
                        .font(.headline.monospacedDigit())
                }
            }
            .accessibilityLabel(snapshot.headline)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                Text("Nekko Agent").font(.caption2.weight(.semibold)).widgetAccentable()
                Text(snapshot.headline).font(.headline)
                if let computer = snapshot.computer { Text(computer).font(.caption2).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(snapshot.online ? Color.green : Color.secondary).frame(width: 7, height: 7)
                    Text(snapshot.computer ?? "Nekko Agent").font(.caption.weight(.semibold)).lineLimit(1)
                }
                Spacer(minLength: 0)
                if snapshot.needsYou > 0 {
                    Text("\(snapshot.needsYou)").font(.system(size: 40, weight: .bold, design: .rounded)).foregroundStyle(.orange)
                    Text(snapshot.needsYou == 1 ? "needs you" : "need you").font(.subheadline.weight(.medium))
                } else {
                    Text(snapshot.headline).font(.title3.weight(.semibold)).lineLimit(2)
                }
                if snapshot.running > 0 && snapshot.needsYou > 0 {
                    Text("\(snapshot.running) working").font(.caption).foregroundStyle(.secondary)
                }
                if snapshot.at > .distantPast {
                    // The app is suspended most of the time: say how old this is.
                    // A relative-style date keeps counting on the Home Screen; a formatted one froze at "now".
                    Text("Updated \(snapshot.at, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}
