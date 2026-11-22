import SwiftUI

/// A small sad Nekko: the secret-agent cat drawn as a slender hand-drawn outline with
/// slim sunglasses, ears drooping, brows tilted up in the middle, a frown and one tear.
/// Original SwiftUI line art in the palette's ink, no asset and no network. Still, so
/// Reduce Motion needs nothing. Decorative: the words next to it say the same thing.
struct SadNekko: View {
    var size: CGFloat = 56
    @Environment(\.palette) private var palette
    @ScaledMetric private var scale: CGFloat = 1

    var body: some View {
        Canvas { context, canvas in
            // A 64 x 64 drawing board.
            context.scaleBy(x: canvas.width / 64, y: canvas.height / 64)
            let line = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

            // Head and ears, one slender outline.
            var head = Path()
            head.move(to: p(14, 36))
            head.addLine(to: p(12, 10))
            head.addLine(to: p(27, 21))
            head.addQuadCurve(to: p(37, 21), control: p(32, 19.5))
            head.addLine(to: p(52, 10))
            head.addLine(to: p(50, 36))
            head.addQuadCurve(to: p(32, 55), control: p(52, 54))
            head.addQuadCurve(to: p(14, 36), control: p(12, 54))
            context.stroke(head, with: .color(palette.ink), style: line)

            // Slim sunglasses: two narrow lenses, a bridge and arms to the ears.
            for x in [CGFloat(17), CGFloat(34)] {
                let lens = Path(roundedRect: CGRect(x: x, y: 30, width: 13, height: 6), cornerRadius: 3)
                context.fill(lens, with: .color(palette.ink))
            }
            var frame = Path()
            frame.move(to: p(30, 32)); frame.addLine(to: p(34, 32))
            frame.move(to: p(17, 32)); frame.addLine(to: p(13.5, 31))
            frame.move(to: p(47, 32)); frame.addLine(to: p(50.5, 31))
            context.stroke(frame, with: .color(palette.ink), style: line)

            // Sad brows: low at the outside, raised in the middle.
            var brows = Path()
            brows.move(to: p(17, 28)); brows.addLine(to: p(28, 25))
            brows.move(to: p(47, 28)); brows.addLine(to: p(36, 25))
            context.stroke(brows, with: .color(palette.inkSoft), style: line)

            // Nose, a frown, and whiskers drooping outward.
            context.fill(Path(ellipseIn: CGRect(x: 30.8, y: 39.5, width: 2.4, height: 1.8)), with: .color(palette.ink))
            var mouth = Path()
            mouth.move(to: p(26.5, 49))
            mouth.addQuadCurve(to: p(37.5, 49), control: p(32, 43.5))
            context.stroke(mouth, with: .color(palette.ink), style: line)
            var whiskers = Path()
            whiskers.move(to: p(13, 42)); whiskers.addLine(to: p(5, 43.5))
            whiskers.move(to: p(13.5, 46)); whiskers.addLine(to: p(6.5, 50))
            whiskers.move(to: p(51, 42)); whiskers.addLine(to: p(59, 43.5))
            whiskers.move(to: p(50.5, 46)); whiskers.addLine(to: p(57.5, 50))
            context.stroke(whiskers, with: .color(palette.inkSoft), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))

            // One tear under the right lens.
            var tear = Path()
            tear.move(to: p(43, 38.5))
            tear.addQuadCurve(to: p(43, 45), control: p(40.5, 42.5))
            tear.addQuadCurve(to: p(43, 38.5), control: p(45.5, 42.5))
            context.fill(tear, with: .color(palette.running))
        }
        .frame(width: size * scale, height: size * scale)
        .accessibilityHidden(true)
    }
}
