import SwiftUI

/// Desktop's pixel cat face, on a 32 x 32 grid. Shared with the widget extension,
/// which tints it by run phase in the Dynamic Island.
struct PixelCat: View {
    var happy = false
    var blink = false
    var fill = Color(red: 16/255, green: 23/255, blue: 20/255)
    var line = Color(red: 242/255, green: 241/255, blue: 233/255)

    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 32, y: size.height / 32)
            func pixels(_ rects: [CGRect]) {
                for rect in rects { context.fill(Path(rect), with: .color(line)) }
            }
            var face = Path()
            face.addLines([(4,5),(6,5),(6,7),(8,7),(8,9),(11,9),(11,10),(21,10),(21,9),(24,9),(24,7),(26,7),(26,5),(28,5),(28,19),(27,19),(27,22),(25,22),(25,24),(22,24),(22,26),(10,26),(10,24),(7,24),(7,22),(5,22),(5,19),(4,19)].map { CGPoint(x: $0.0, y: $0.1) })
            face.closeSubpath()
            context.fill(face, with: .color(fill))
            context.stroke(face, with: .color(line), style: StrokeStyle(lineWidth: 2, lineJoin: .miter))
            if happy {
                for x in [9, 19] {
                    pixels([CGRect(x: x, y: 15, width: 1, height: 2), CGRect(x: x+1, y: 14, width: 2, height: 1), CGRect(x: x+3, y: 15, width: 1, height: 2)])
                }
            } else {
                pixels(blink ? [CGRect(x: 10, y: 17, width: 4, height: 1), CGRect(x: 19, y: 17, width: 4, height: 1)] : [CGRect(x: 11, y: 15, width: 2, height: 3), CGRect(x: 20, y: 15, width: 2, height: 3)])
            }
            context.fill(Path(CGRect(x: 15, y: 20, width: 2, height: 1)), with: .color(Color(red: 167/255, green: 200/255, blue: 172/255)))
        }
        .accessibilityHidden(true)
    }
}

extension AgentRunAttributes.Phase {
    var tint: Color {
        switch self {
        case .running: return Color(red: 0.55, green: 0.49, blue: 1)
        case .approval, .question: return .orange
        case .done: return .green
        case .failed: return .red
        }
    }
}

/// The run's mascot for the Live Activity: the cat in the phase's color, with a
/// small status badge bottom right. Live Activities can't run a clock, so the
/// cat hops (a new identity, so the system plays the transition) when the phase
/// changes and every third step; while working it alternates blinking.
struct RunMascot: View {
    let phase: AgentRunAttributes.Phase
    var steps = 0
    var size: CGFloat = 22

    var body: some View {
        let beat = steps / 3
        ZStack(alignment: .bottomTrailing) {
            PixelCat(happy: phase == .done, blink: phase == .running && beat % 2 == 1, fill: phase.tint, line: .black)
                .id("\(phase.rawValue)-\(beat)")
                .transition(.scale(scale: 0.6, anchor: .bottom).combined(with: .opacity))
            StatusBadge(phase: phase)
                .frame(width: size * 0.38, height: size * 0.38)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label)
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
}

/// Drawn, not a system symbol: ellipsis (working), ! (needs you), check (done), x (failed).
private struct StatusBadge: View {
    let phase: AgentRunAttributes.Phase

    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 10, y: size.height / 10)
            let disc = Path(ellipseIn: CGRect(x: 0, y: 0, width: 10, height: 10))
            context.fill(disc, with: .color(phase.tint))
            // A black ring cuts the badge out of the cat behind it.
            context.stroke(disc, with: .color(.black), lineWidth: 1.4)
            var glyph = Path()
            let ink = GraphicsContext.Shading.color(.black)
            switch phase {
            case .running:
                for x in [2.7, 5, 7.3] { glyph.addEllipse(in: CGRect(x: x - 0.85, y: 4.15, width: 1.7, height: 1.7)) }
                context.fill(glyph, with: ink)
            case .approval, .question:
                glyph.addRect(CGRect(x: 4.2, y: 2, width: 1.6, height: 3.9))
                glyph.addEllipse(in: CGRect(x: 4.15, y: 6.6, width: 1.7, height: 1.7))
                context.fill(glyph, with: ink)
            case .done:
                glyph.addLines([CGPoint(x: 2.6, y: 5.2), CGPoint(x: 4.3, y: 6.9), CGPoint(x: 7.5, y: 3.3)])
                context.stroke(glyph, with: ink, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            case .failed:
                glyph.move(to: CGPoint(x: 3.3, y: 3.3)); glyph.addLine(to: CGPoint(x: 6.7, y: 6.7))
                glyph.move(to: CGPoint(x: 6.7, y: 3.3)); glyph.addLine(to: CGPoint(x: 3.3, y: 6.7))
                context.stroke(glyph, with: ink, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            }
        }
    }
}
