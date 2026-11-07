import SwiftUI

/// The desktop GroupActivity's still frames: Nekko with bricks, a checklist,
/// or radar. A group identity, not the individual chat's working/done glyph.
struct ChatGroupActivity: View {
    let kind: String
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .leading) {
            PixelCat().frame(width: 16, height: 16)
            Canvas { context, size in
                context.scaleBy(x: size.width / 24, y: size.height / 16)
                func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, soft: Bool = false) {
                    context.fill(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(palette.success.opacity(soft ? 0.45 : 1)))
                }
                func bitmap(_ rows: [String], _ x: Int, _ y: Int) {
                    for (j, row) in rows.enumerated() {
                        for (i, pixel) in row.enumerated() where pixel == "#" {
                            box(CGFloat(x + i), CGFloat(y + j), 1, 1)
                        }
                    }
                }
                switch kind {
                case "status:building":
                    for i in 0..<3 {
                        box(17, CGFloat(13 - i * 2), 6, 1, soft: i % 2 == 0)
                        box(17, CGFloat(14 - i * 2), 6, 1, soft: i % 2 == 1)
                    }
                    box(17, 6, 3, 3)
                    box(20, 7, 4, 1)
                case "status:verifying":
                    for y in [3, 7, 11] {
                        bitmap(["...#", "#.#.", ".#.."], 16, y)
                        box(21, CGFloat(y + 1), 3, 1, soft: true)
                    }
                default:
                    box(18, 7, 2, 2)
                    bitmap([".####.", "#....#", "#....#", "#....#", "#....#", ".####."], 16, 5)
                }
            }
        }
        .frame(width: 24, height: 16)
        .accessibilityHidden(true)
    }
}
