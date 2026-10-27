import NekkoProtocol
import SwiftUI

/// A chat's status on the Live Activity card: the shapes of `ChatStatusIcon`
/// (rocket, question mark, check, Zz) plus a cross for a failure. Colors are
/// fixed because the card is always dark.
struct LiveStatusGlyph: View {
    let state: LiveChatState
    var size: CGFloat = 14
    /// Overrides the state's tint (the mascot badge draws dark ink on the tint).
    var ink: Color?

    var body: some View {
        state.shape
            .stroke(ink ?? state.tint, style: StrokeStyle(lineWidth: size / 9, lineCap: .round, lineJoin: .round))
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(state.label)
    }
}

extension LiveChatState {
    var tint: Color {
        switch self {
        case .needsYou: return Color(red: 1, green: 0.62, blue: 0.04)
        case .working: return Color(red: 0.55, green: 0.49, blue: 1)
        case .watching: return Color(red: 0.04, green: 0.52, blue: 1)
        case .done: return Color(red: 0.19, green: 0.82, blue: 0.35)
        case .failed: return Color(red: 1, green: 0.27, blue: 0.23)
        }
    }

    var label: String {
        switch self {
        case .needsYou: return String(localized: "Needs you")
        case .working: return String(localized: "Working")
        case .watching: return String(localized: "Watching")
        case .done: return String(localized: "Done")
        case .failed: return String(localized: "Failed")
        }
    }

    /// The status line at Minimal, and whenever a push left the step out.
    var phaseLine: String {
        switch self {
        case .needsYou: return String(localized: "Needs your approval")
        case .working: return String(localized: "Working…")
        case .watching: return String(localized: "Watching a pull request")
        case .done: return String(localized: "Finished")
        case .failed: return String(localized: "Stopped with an error")
        }
    }

    fileprivate var shape: AnyShape {
        switch self {
        case .needsYou: return AnyShape(QuestionGlyph())
        case .working: return AnyShape(RocketGlyph())
        case .watching: return AnyShape(SleepGlyph())
        case .done: return AnyShape(CheckGlyph())
        case .failed: return AnyShape(CrossGlyph())
        }
    }
}

/// The shapes below are drawn on an 18 x 18 grid and scaled to their frame.
private func scaled(_ path: Path, _ rect: CGRect) -> Path {
    path.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 18, y: rect.height / 18))
}

struct RocketGlyph: Shape {
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
        return scaled(path, rect)
    }
}

struct QuestionGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 5.5, y: 6))
        path.addQuadCurve(to: CGPoint(x: 9, y: 2.5), control: CGPoint(x: 5.5, y: 2.5))
        path.addQuadCurve(to: CGPoint(x: 12.5, y: 6), control: CGPoint(x: 12.5, y: 2.5))
        path.addQuadCurve(to: CGPoint(x: 9, y: 10), control: CGPoint(x: 12.5, y: 8.5))
        path.addLine(to: CGPoint(x: 9, y: 11.5))
        path.addEllipse(in: CGRect(x: 8.5, y: 14.5, width: 1, height: 1))
        return scaled(path, rect)
    }
}

struct CheckGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addLines([CGPoint(x: 3.5, y: 9.5), CGPoint(x: 7.5, y: 13.5), CGPoint(x: 14.5, y: 4.5)])
        return scaled(path, rect)
    }
}

struct CrossGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 4.5, y: 4.5)); path.addLine(to: CGPoint(x: 13.5, y: 13.5))
        path.move(to: CGPoint(x: 13.5, y: 4.5)); path.addLine(to: CGPoint(x: 4.5, y: 13.5))
        return scaled(path, rect)
    }
}

/// "Zz": a big Z and a small one up and to the right.
struct SleepGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addLines([CGPoint(x: 2, y: 8), CGPoint(x: 9, y: 8), CGPoint(x: 2, y: 15.5), CGPoint(x: 9, y: 15.5)])
        path.addLines([CGPoint(x: 11, y: 2.5), CGPoint(x: 16, y: 2.5), CGPoint(x: 11, y: 8), CGPoint(x: 16, y: 8)])
        return scaled(path, rect)
    }
}

struct MicGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRoundedRect(in: CGRect(x: 6.5, y: 1.5, width: 5, height: 9.5), cornerSize: CGSize(width: 2.5, height: 2.5))
        path.move(to: CGPoint(x: 3.5, y: 8.5))
        path.addCurve(to: CGPoint(x: 14.5, y: 8.5), control1: CGPoint(x: 3.5, y: 15), control2: CGPoint(x: 14.5, y: 15))
        path.move(to: CGPoint(x: 9, y: 13.5)); path.addLine(to: CGPoint(x: 9, y: 16.5))
        path.move(to: CGPoint(x: 6, y: 16.5)); path.addLine(to: CGPoint(x: 12, y: 16.5))
        return scaled(path, rect)
    }
}
