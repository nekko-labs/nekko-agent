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
        // Our status glyphs (docs/design-system.md, Agent status), never SF Symbols.
        Group {
            if activity == .running {
                glyph(RocketGlyph(), palette.success)
            } else if activity == .needsYou {
                glyph(QuestionGlyph(), palette.warning)
            } else if activity == .failed {
                glyph(WarningGlyph(), palette.danger)
            } else if waiting {
                glyph(ClockGlyph(), palette.inkFaint)
            } else if activeWatchCount <= 0 {
                glyph(CheckGlyph(), palette.inkFaint)
            } else {
                glyph(SleepGlyph(), palette.inkFaint)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private func glyph(_ shape: some Shape, _ color: Color) -> some View {
        shape.stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            .frame(width: 18, height: 18)
    }

    var label: String {
        if activity == .running { return String(localized: "Working") }
        if activity == .needsYou { return String(localized: "Needs you") }
        if activity == .failed { return String(localized: "Error") }
        if waiting { return String(localized: "Waiting to send") }
        return activeWatchCount <= 0 ? String(localized: "Done") : String(localized: "Watching")
    }
}
