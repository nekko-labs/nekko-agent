import NekkoProtocol
import SwiftUI

/// Match desktop's shapes, so colour is never the only status cue.
struct ChatStatusIcon: View {
    let activity: Activity?
    var completed = false
    var waiting = false
    var activeWatchCount: Int64 = 0
    @Environment(\.palette) private var palette

    var body: some View {
        Group {
            if activity == .running {
                RocketGlyph().stroke(palette.success, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).frame(width: 18, height: 18)
            } else if activity == .needsYou {
                Image(systemName: "questionmark").foregroundStyle(palette.warning)
            } else if waiting {
                Image(systemName: "clock").foregroundStyle(palette.inkFaint)
            } else if activeWatchCount <= 0 {
                Image(systemName: "checkmark").foregroundStyle(palette.inkFaint)
            } else {
                Text("Zz").foregroundStyle(palette.inkFaint)
            }
        }
        .font(.caption.weight(.semibold))
        .accessibilityLabel(label)
    }

    var label: String {
        if activity == .running { return String(localized: "Working") }
        if activity == .needsYou { return String(localized: "Needs you") }
        if waiting { return String(localized: "Waiting to send") }
        return activeWatchCount <= 0 ? String(localized: "Done") : String(localized: "Idle")
    }
}
