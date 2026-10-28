import SwiftUI

/// Centered root mascot, outside iOS 26's shared toolbar glass.
struct RootMascot: ToolbarContent {
    var working = false

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .principal) { ChatMascot(working: working) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) { ChatMascot(working: working) }
        }
    }
}

/// Desktop's pixel cat, with a local greeting. Never sends a chat or changes settings.
struct ChatMascot: View {
    var working = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var greeting = false
    @State private var greetingID = 0

    var body: some View {
        Button {
            greeting = true
            greetingID += 1
        } label: {
            TimelineView(.animation(minimumInterval: 0.2, paused: reduceMotion || scenePhase != .active)) { timeline in
                let frame = Int(timeline.date.timeIntervalSinceReferenceDate * 5) % 40
                PixelCat(happy: greeting, blink: !working && frame == 14)
                    .frame(width: 40, height: 40)
                    .offset(y: reduceMotion || scenePhase != .active ? 0 : working && frame % 4 < 2 ? -2 : 0)
            }
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Say hello to Nekko")
        .accessibilityValue(greeting ? String(localized: "Hello!") : working ? String(localized: "Working") : String(localized: "Idle"))
        .accessibilityIdentifier("chats.mascot")
        .task(id: greetingID) {
            guard greeting else { return }
            do {
                try await Task.sleep(for: .milliseconds(1200))
                greeting = false
            } catch { /* A newer tap or leaving the screen cancels the greeting. */ }
        }
    }
}

/// The desktop's greeting cat (GreetingNekko.tsx): a face peeking over the new chat's
/// composer, its paws on the box's top edge. Decorative.
struct GreetingCat: View {
    @Environment(\.palette) private var palette

    var body: some View {
        Canvas { context, size in
            // The desktop's 32 x 30 viewBox.
            context.scaleBy(x: size.width / 32, y: size.height / 30)
            func polygon(_ points: [(CGFloat, CGFloat)]) -> Path {
                var path = Path()
                path.addLines(points.map { CGPoint(x: $0.0, y: $0.1) })
                path.closeSubpath()
                return path
            }
            func rects(_ r: [(CGFloat, CGFloat, CGFloat, CGFloat)], _ color: Color, opacity: Double = 1) {
                for (x, y, w, h) in r { context.fill(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(color.opacity(opacity))) }
            }
            let face = polygon([(4,5),(6,5),(6,7),(8,7),(8,9),(11,9),(11,10),(21,10),(21,9),(24,9),(24,7),(26,7),(26,5),(28,5),(28,19),(27,19),(27,22),(25,22),(25,24),(22,24),(22,26),(10,26),(10,24),(7,24),(7,22),(5,22),(5,19),(4,19)])
            // The composer hides the chin, but the paws hang in front of its edge.
            var head = context
            head.clip(to: Path(CGRect(x: 0, y: 0, width: 32, height: 25)))
            head.fill(face, with: .color(palette.surface))
            head.stroke(face, with: .color(palette.ink), style: StrokeStyle(lineWidth: 2, lineJoin: .miter))
            // Eyes glance down at the message box; no colored mouth or nose.
            for x in [11, 20] {
                head.fill(Path(CGRect(x: x, y: 16, width: 2, height: 3)), with: .color(palette.ink))
            }
            // Flip around the edge (y = 25), putting the small toes at the bottom.
            context.translateBy(x: 0, y: 50)
            context.scaleBy(x: 1, y: -1)
            rects([(6, 24, 5, 4), (21, 24, 5, 4)], palette.surface)
            context.fill(polygon([(5,23),(12,23),(12,27),(11,27),(11,24),(6,24),(6,27),(5,27)]), with: .color(palette.ink))
            context.fill(polygon([(20,23),(27,23),(27,27),(26,27),(26,24),(21,24),(21,27),(20,27)]), with: .color(palette.ink))
            rects([(7.5, 24, 0.5, 1.5), (9, 24, 0.5, 1.5), (22.5, 24, 0.5, 1.5), (24, 24, 0.5, 1.5)], palette.ink, opacity: 0.55)
        }
        .accessibilityHidden(true)
    }
}
