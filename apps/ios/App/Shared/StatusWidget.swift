import SwiftUI
import WidgetKit

/// What the Home Screen and Lock Screen widgets show: counts, never chat titles
/// or tool details, so nothing private sits on a screen anyone can glance at.
/// The app writes it to the App Group whenever the counts change; the widget
/// only reads it. Compiled into both the app and the widget extension.
struct StatusSnapshot: Codable, Equatable {
    var computer: String?
    var online: Bool
    var needsYou: Int
    var running: Int
    var at: Date

    static let appGroup = "group.com.nekko.native.ios"
    static let key = "widget.status"
    static let kind = "NekkoStatus"

    static let empty = StatusSnapshot(computer: nil, online: false, needsYou: 0, running: 0, at: .distantPast)

    static func load(_ defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> StatusSnapshot {
        guard let data = defaults?.data(forKey: key), let s = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else { return .empty }
        return s
    }

    /// Saves and returns whether anything the widget shows changed.
    @discardableResult
    func save(_ defaults: UserDefaults? = UserDefaults(suiteName: StatusSnapshot.appGroup)) -> Bool {
        let previous = StatusSnapshot.load(defaults)
        guard let data = try? JSONEncoder().encode(self) else { return false }
        defaults?.set(data, forKey: StatusSnapshot.key)
        var same = previous
        same.at = at
        return same != self
    }

    var headline: String {
        if computer == nil { return "Not paired" }
        if needsYou > 0 { return needsYou == 1 ? "1 needs you" : "\(needsYou) need you" }
        if running > 0 { return running == 1 ? "1 working" : "\(running) working" }
        return online ? "All quiet" : "Offline"
    }
}

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
                    Text(snapshot.at, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}
