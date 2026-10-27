import SwiftUI

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

private struct PixelCat: View {
    let happy: Bool
    let blink: Bool

    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 32, y: size.height / 32)
            func shape(_ points: [CGPoint], fill: Color, stroke: Bool = false) {
                var path = Path()
                path.addLines(points)
                path.closeSubpath()
                context.fill(path, with: .color(fill))
                if stroke { context.stroke(path, with: .color(Color(red: 242/255, green: 241/255, blue: 233/255)), style: StrokeStyle(lineWidth: 2, lineJoin: .miter)) }
            }
            func pixels(_ rects: [CGRect], color: Color) {
                for rect in rects { context.fill(Path(rect), with: .color(color)) }
            }
            shape([(4,5),(6,5),(6,7),(8,7),(8,9),(11,9),(11,10),(21,10),(21,9),(24,9),(24,7),(26,7),(26,5),(28,5),(28,19),(27,19),(27,22),(25,22),(25,24),(22,24),(22,26),(10,26),(10,24),(7,24),(7,22),(5,22),(5,19),(4,19)].map { CGPoint(x: $0.0, y: $0.1) }, fill: Color(red: 16/255, green: 23/255, blue: 20/255), stroke: true)
            let cream = Color(red: 242/255, green: 241/255, blue: 233/255)
            if happy {
                for x in [9, 19] {
                    pixels([CGRect(x: x, y: 15, width: 1, height: 2), CGRect(x: x+1, y: 14, width: 2, height: 1), CGRect(x: x+3, y: 15, width: 1, height: 2)], color: cream)
                }
            } else {
                pixels(blink ? [CGRect(x: 10, y: 17, width: 4, height: 1), CGRect(x: 19, y: 17, width: 4, height: 1)] : [CGRect(x: 11, y: 15, width: 2, height: 3), CGRect(x: 20, y: 15, width: 2, height: 3)], color: cream)
            }
            pixels([CGRect(x: 15, y: 20, width: 2, height: 1)], color: Color(red: 167/255, green: 200/255, blue: 172/255))
        }
        .accessibilityHidden(true)
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
            context.fill(face, with: .color(palette.surface))
            context.stroke(face, with: .color(palette.ink), style: StrokeStyle(lineWidth: 2, lineJoin: .miter))
            // Eyes glance down at the message box.
            rects([(11, 16, 2, 3), (20, 16, 2, 3)], palette.ink)
            rects([(15, 20, 2, 1)], palette.accent)
            rects([(7, 23, 5, 5), (20, 23, 5, 5)], palette.surface)
            context.fill(polygon([(6,22),(13,22),(13,27),(12,27),(12,23),(7,23),(7,27),(6,27)]), with: .color(palette.ink))
            context.fill(polygon([(19,22),(26,22),(26,27),(25,27),(25,23),(20,23),(20,27),(19,27)]), with: .color(palette.ink))
            rects([(8.5, 23, 0.5, 1.5), (10, 23, 0.5, 1.5), (21.5, 23, 0.5, 1.5), (23, 23, 0.5, 1.5)], palette.ink, opacity: 0.55)
        }
        .accessibilityHidden(true)
    }
}
