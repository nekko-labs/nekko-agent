import SwiftUI

/// Desktop's pixel cat face, on a 32 x 32 grid. Shared with the widget extension,
/// whose Live Activity card wears it as the mascot.
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
