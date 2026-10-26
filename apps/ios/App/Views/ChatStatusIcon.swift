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
                RocketGlyph().stroke(palette.running, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)).frame(width: 18, height: 18)
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

private struct RocketGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        // A diagonal rocket, with fins, window and exhaust, like desktop.
        path.move(to: CGPoint(x: 7, y: 11))
        path.addQuadCurve(to: CGPoint(x: 16, y: 2), control: CGPoint(x: 8, y: 2))
        path.addQuadCurve(to: CGPoint(x: 7, y: 11), control: CGPoint(x: 16, y: 10))
        path.move(to: CGPoint(x: 7, y: 7))
        path.addLines([CGPoint(x: 3, y: 7), CGPoint(x: 2, y: 11), CGPoint(x: 7, y: 11), CGPoint(x: 7, y: 16), CGPoint(x: 11, y: 15), CGPoint(x: 11, y: 11)])
        path.addEllipse(in: CGRect(x: 10, y: 5, width: 3, height: 3))
        path.move(to: CGPoint(x: 4, y: 13))
        path.addLine(to: CGPoint(x: 2, y: 16))
        return path.applying(CGAffineTransform(scaleX: rect.width / 18, y: rect.height / 18))
    }
}
