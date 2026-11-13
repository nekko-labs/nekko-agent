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

/// Ten flakes in the air at once, each in one of eight designs. Every fall picks a new
/// design, column and size at random; each flake's (slow) speed and spin are random per
/// launch. Coordinates adapt to compact and wide layouts.
enum WinterFlakes {
    static let count = 10
    static let typeCount = designs.count
    /// Radius range (points) and seconds per fall: large and always slow.
    static let radius: ClosedRange<Double> = 8...14
    static let fall: ClosedRange<Double> = 48...96

    struct Flake: Equatable {
        let position: CGPoint
        let type: Int
        let radius: Double
        let angle: Double
    }

    /// A design is one arm pointing up from the centre of a 24 x 24 box, repeated six
    /// times, plus beads on each arm and an optional centre ring. Matches the desktop's
    /// `SNOWFLAKE_TYPES` (WinterBackground.tsx).
    struct Design {
        var lines: [[(Double, Double)]]
        var beads: [(Double, Double, Double)] = []
        var ring: Double? = nil
    }

    static let designs: [Design] = [
        Design(lines: [[(12, 12), (12, 2)], [(9.6, 4.4), (12, 6.6), (14.4, 4.4)]]),
        Design(lines: [[(12, 12), (12, 2)], [(10.5, 3.5), (12, 5), (13.5, 3.5)], [(9.9, 5.9), (12, 7.6), (14.1, 5.9)]]),
        Design(lines: [[(12, 12), (12, 4.8)]], beads: [(12, 3.2, 1.2)]),
        Design(lines: [[(12, 12), (12, 2)], [(10, 4.6), (14, 4.6)], [(10.6, 7.6), (13.4, 7.6)]]),
        Design(lines: [[(12, 12), (12, 6.4)], [(12, 6.4), (10.4, 4), (12, 1.6), (13.6, 4), (12, 6.4)]]),
        Design(lines: [[(12, 12), (12, 2)], [(10.2, 3.8), (12, 2), (13.8, 3.8)], [(10.7, 6.5), (12, 5.2), (13.3, 6.5)]]),
        Design(lines: [[(12, 8.6), (12, 2.4)], [(10.6, 4.4), (12, 5.8), (13.4, 4.4)], [(12, 8.6), (14.98, 10.3)]]),
        Design(lines: [[(12, 9.6), (12, 2)], [(9.4, 5.6), (12, 7.2), (14.6, 5.6)], [(10.4, 3.6), (12, 4.6), (13.6, 3.6)]], ring: 2.4),
    ]

    /// Where flake `index` is after `seconds`, for this launch's `seed`.
    static func flake(_ index: Int, seconds: Double, seed: UInt64) -> Flake {
        let period = lerp(fall, unit(seed, index, -1, 0))
        let progress = unit(seed, index, -1, 1) + seconds / period
        let cycle = Int(progress.rounded(.down))
        let y = progress - Double(cycle)
        let spin = unit(seed, index, -1, 2) < 0.5 ? -1.0 : 1.0
        let column = 0.04 + unit(seed, index, cycle, 3) * 0.92
        return Flake(
            position: CGPoint(x: column + sin(seconds / 9 + Double(index)) * 0.02, y: y),
            type: min(typeCount - 1, Int(unit(seed, index, cycle, 4) * Double(typeCount))),
            radius: lerp(radius, unit(seed, index, cycle, 5)),
            angle: spin * y * 2.3
        )
    }

    /// Design `type` at radius 1, centred on the origin.
    static func path(_ type: Int) -> Path {
        let design = designs[type]
        var path = Path()
        for arm in 0..<6 {
            let angle = Double(arm) * .pi / 3
            func point(_ x: Double, _ y: Double) -> CGPoint {
                let along = (12 - y) / 10, across = (x - 12) / 10
                return CGPoint(x: along * sin(angle) + across * cos(angle), y: -along * cos(angle) + across * sin(angle))
            }
            for line in design.lines {
                path.move(to: point(line[0].0, line[0].1))
                for (x, y) in line.dropFirst() { path.addLine(to: point(x, y)) }
            }
            for (x, y, r) in design.beads {
                let c = point(x, y)
                path.addEllipse(in: CGRect(x: c.x - r / 10, y: c.y - r / 10, width: r / 5, height: r / 5))
            }
        }
        if let ring = design.ring {
            path.addEllipse(in: CGRect(x: -ring / 10, y: -ring / 10, width: ring / 5, height: ring / 5))
        }
        return path
    }

    /// The classic design, also stitched on the Winter beanie.
    static func snowflake() -> Path { path(0) }

    private static func lerp(_ range: ClosedRange<Double>, _ t: Double) -> Double {
        range.lowerBound + (range.upperBound - range.lowerBound) * t
    }

    /// A repeatable number in 0..<1 (SplitMix64), the same on Android.
    static func unit(_ seed: UInt64, _ index: Int, _ cycle: Int, _ salt: Int) -> Double {
        var z = seed &+ UInt64(bitPattern: Int64(index)) &* 0x9E37_79B9_7F4A_7C15
            &+ UInt64(bitPattern: Int64(cycle)) &* 0xBF58_476D_1CE4_E5B9
            &+ UInt64(bitPattern: Int64(salt)) &* 0x94D0_49BB_1331_11EB
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z = z ^ (z >> 31)
        return Double(z >> 11) / Double(1 << 53)
    }
}

/// Decorative only. No timer while inactive, and a fixed composition with reduced motion.
struct WinterSnow: View {
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var elapsed: Double = 0
    @State private var activeSince: Date?
    @State private var seed = UInt64.random(in: .min ... .max)

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
                    let flake = WinterFlakes.flake(index, seconds: seconds, seed: seed)
                    let margin = 2 * WinterFlakes.radius.upperBound
                    var layer = context
                    layer.translateBy(x: flake.position.x * size.width, y: flake.position.y * (size.height + 2 * margin) - margin)
                    layer.rotate(by: .radians(flake.angle))
                    layer.scaleBy(x: flake.radius, y: flake.radius)
                    layer.stroke(WinterFlakes.path(flake.type), with: .color(palette.accent.opacity(0.18)),
                                 style: StrokeStyle(lineWidth: 1.2 / flake.radius, lineCap: .round, lineJoin: .round))
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
                    context.fill(Path(CGRect(x: CGFloat(x), y: 10, width: 0.5, height: 2)), with: .color(palette.paper.opacity(0.25)))
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
