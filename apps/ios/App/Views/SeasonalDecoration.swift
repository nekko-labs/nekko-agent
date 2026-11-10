import SwiftUI

/// Resolved from the same preset as the palette, including Match my computer.
enum SeasonalDecoration: Equatable {
    case none, winter, spooky

    init(preset: ThemePreset?) {
        switch preset?.id {
        case "winter": self = .winter
        case "autumn": self = .spooky
        default: self = .none
        }
    }
}

private struct SeasonalDecorationKey: EnvironmentKey {
    static let defaultValue = SeasonalDecoration.none
}

extension EnvironmentValues {
    var seasonalDecoration: SeasonalDecoration {
        get { self[SeasonalDecorationKey.self] }
        set { self[SeasonalDecorationKey.self] = newValue }
    }
}

/// Eight fixed seeds, not random particles. Coordinates adapt to compact and wide layouts.
enum WinterFlakes {
    static let count = 8
    static let catIndex = 3

    static func position(_ index: Int, seconds: Double) -> CGPoint {
        let seed = Double(index)
        let y = (0.06 + seed * 0.113 + seconds / (24 + seed * 2)).truncatingRemainder(dividingBy: 1)
        return CGPoint(x: (seed + 0.5) / Double(count) + sin(seconds / 7 + seed) * 0.018, y: y)
    }

    static func snowflake() -> Path {
        var path = Path()
        for arm in 0..<6 {
            let angle = Double(arm) * .pi / 3
            func point(_ radius: Double, _ offset: Double = 0) -> CGPoint {
                CGPoint(x: cos(angle + offset) * radius, y: sin(angle + offset) * radius)
            }
            path.move(to: .zero)
            path.addLine(to: point(1))
            for offset in [-0.45, 0.45] {
                path.move(to: point(0.55))
                path.addLine(to: point(0.82, offset))
            }
        }
        return path
    }

    static func cat() -> Path {
        var path = Path()
        path.addLines([(-0.85, -0.85), (-0.35, -0.35), (0.35, -0.35), (0.85, -0.85), (0.85, 0.4),
                       (0.45, 0.85), (-0.45, 0.85), (-0.85, 0.4)].map { CGPoint(x: $0.0, y: $0.1) })
        path.closeSubpath()
        for x in [-0.3, 0.3] {
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: 0.2))
        }
        return path
    }
}

/// Decorative only. No timer while inactive, and a fixed composition with reduced motion.
struct WinterSnow: View {
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var elapsed: Double = 0
    @State private var activeSince: Date?

    private var staticSnow: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReduceMotion") { return true }
        #endif
        return reduceMotion
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: staticSnow || scenePhase != .active)) { timeline in
            let seconds = staticSnow ? 0 : elapsed + (activeSince.map { max(0, timeline.date.timeIntervalSince($0)) } ?? 0)
            Canvas { context, size in
                for index in 0..<WinterFlakes.count {
                    let position = WinterFlakes.position(index, seconds: seconds)
                    var flake = context
                    flake.translateBy(x: position.x * size.width, y: position.y * (size.height + 24) - 12)
                    let radius: CGFloat = index == WinterFlakes.catIndex ? 6 : CGFloat(3 + index % 3)
                    flake.scaleBy(x: radius, y: radius)
                    flake.stroke(index == WinterFlakes.catIndex ? WinterFlakes.cat() : WinterFlakes.snowflake(),
                                 with: .color(palette.accent.opacity(0.24)),
                                 style: StrokeStyle(lineWidth: 0.8 / radius, lineCap: .round, lineJoin: .round))
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { updateClock() }
        .onChange(of: scenePhase) { _, _ in updateClock() }
        .onChange(of: staticSnow) { _, _ in updateClock() }
        .onDisappear { updateClock(running: false) }
    }

    private func updateClock(running: Bool = true) {
        let now = Date()
        if let activeSince { elapsed += max(0, now.timeIntervalSince(activeSince)) }
        activeSince = running && !staticSnow && scenePhase == .active ? now : nil
    }
}

/// On the cat's existing 32 x 32 grid, leaving its eyes and button geometry alone.
struct MascotHat: View {
    let decoration: SeasonalDecoration
    @Environment(\.palette) private var palette

    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 32, y: size.height / 32)
            func polygon(_ points: [(CGFloat, CGFloat)]) -> Path {
                var path = Path()
                path.addLines(points.map { CGPoint(x: $0.0, y: $0.1) })
                path.closeSubpath()
                return path
            }
            switch decoration {
            case .winter:
                // Berry knit with cat-ear tips, a cream folded brim and stitched snowflake.
                let crown = polygon([(4, 10), (4, 2), (10, 5), (16, 4), (22, 5), (28, 2), (28, 10)])
                context.fill(crown, with: .color(palette.danger))
                context.fill(crown, with: .color(palette.accent.opacity(0.22)))
                context.fill(crown, with: .color(palette.paper.opacity(0.25)))
                context.stroke(crown, with: .color(palette.ink.opacity(0.7)), lineWidth: 0.6)
                context.fill(Path(roundedRect: CGRect(x: 3, y: 9, width: 26, height: 4), cornerRadius: 1), with: .color(palette.ink))
                for x in stride(from: 5, through: 27, by: 2) {
                    context.fill(Path(CGRect(x: x, y: 10, width: 0.5, height: 2)), with: .color(palette.paper.opacity(0.25)))
                }
                context.translateBy(x: 16, y: 7)
                context.scaleBy(x: 2, y: 2)
                context.stroke(WinterFlakes.snowflake(), with: .color(palette.ink), lineWidth: 0.35)
            case .spooky:
                let crown = polygon([(6, 10), (13, 0.5), (22, 2), (17, 3), (25, 10)])
                context.fill(crown, with: .color(palette.surface2))
                context.stroke(crown, with: .color(palette.accent), lineWidth: 0.7)
                context.fill(Path(roundedRect: CGRect(x: 2, y: 9, width: 28, height: 3), cornerRadius: 1), with: .color(palette.accent))
                context.fill(Path(CGRect(x: 14, y: 6, width: 3, height: 2)), with: .color(palette.warning))
            case .none:
                break
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
