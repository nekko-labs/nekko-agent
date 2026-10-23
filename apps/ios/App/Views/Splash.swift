import SwiftUI

/// The opening animation, the desktop's (apps/desktop/src/renderer/splash.ts) on
/// the iPhone: the cat builds up from pixels on a 120 BPM beat, then zooms
/// towards the viewer while the inside of the cat opens as a window onto the
/// app, until the app fills the screen. Drawn from elapsed time in one Canvas,
/// from the same generated layers (SplashCells.swift). Reduce Motion fades a
/// solid ground instead. The launch screen is the same lavender, so nothing flashes.
struct SplashView: View {
    var onDone: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()
    @State private var faded = false

    static let ground = Color(red: 0x9d / 255, green: 0x8c / 255, blue: 0xe6 / 255)
    private static let ink = Color.white
    /// One beat, in seconds.
    private static let B = 0.5
    private static let zoomAt = 2.5 * B
    private static let zoomFor = 1.05 * B

    private static let head = SVGPath.parse(SplashCells.brandHead)
    /// The window inside the cat: the head's second subpath.
    private static let inner = SVGPath.parse(String(SplashCells.brandHead.split(separator: "Z", maxSplits: 1)[1]))
    private static let mid = SVGPath.parse(SplashCells.midPath)
    private static let fine = SVGPath.parse(SplashCells.finePath)

    var body: some View {
        Group {
            if reduceMotion {
                Self.ground.opacity(faded ? 0 : 1)
                    .task {
                        try? await Task.sleep(for: .milliseconds(300))
                        withAnimation(.easeOut(duration: 0.25)) { faded = true }
                        try? await Task.sleep(for: .milliseconds(260))
                        onDone()
                    }
            } else {
                TimelineView(.animation) { tl in
                    Canvas { ctx, size in draw(&ctx, size, tl.date.timeIntervalSince(start)) }
                }
                .task {
                    try? await Task.sleep(for: .seconds(Self.zoomAt + Self.zoomFor + 0.05))
                    onDone()
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ t: Double) {
        let (W, H, B) = (size.width, size.height, Self.B)
        // Logo units: the mark spans roughly x 2..22. Small and central, a little under a tenth of the screen.
        let k = max(40, max(W, H) * 0.085) / 20
        let (ox, oy) = (W / 2 - 12 * k, H / 2 - 9 * k)
        let place = CGAffineTransform(translationX: ox, y: oy).scaledBy(x: k, y: k)
        let (cx, cy) = (ox + 12 * k, oy + 10.6 * k)
        let z = zoomScale(t, reach: hypot(W, H) / (8 * k) * 1.6)
        let zoom = CGAffineTransform(translationX: cx, y: cy).scaledBy(x: z, y: z).translatedBy(x: -cx, y: -cy)
        let logo = place.concatenating(zoom)

        // The ground, with the cat's window cut out of it.
        var ground = Path(CGRect(x: -W, y: -H, width: 3 * W, height: 3 * H))
        ground.addPath(Self.inner, transform: logo)
        ctx.fill(ground, with: .color(Self.ground), style: FillStyle(eoFill: true))

        var c = ctx
        c.concatenate(logo)
        // The lid keeps the window shut until the zoom.
        let lid = 1 - Ease.inOut(clamp((t - Self.zoomAt - 0.05 * Self.zoomFor) / (0.35 * Self.zoomFor)))
        if lid > 0 {
            var l = c
            l.opacity = lid
            l.fill(Self.inner, with: .color(Self.ground))
            l.stroke(Self.inner, with: .color(Self.ground), lineWidth: 0.2)
        }
        // A small settle each time the resolution steps up.
        var pulse = 1.0
        for at in [B, 1.5 * B, 2 * B] where t >= at && t < at + 0.22 * B {
            pulse = 0.988 + 0.012 * Ease.out((t - at) / (0.22 * B))
        }
        c.concatenate(CGAffineTransform(translationX: 12, y: 9).scaledBy(x: pulse, y: pulse).translatedBy(x: -12, y: -9))

        let ink = GraphicsContext.Shading.color(Self.ink)
        if t < B {
            // Beat 1: chunky pixels pop in left to right.
            let s = SplashCells.chunkySize
            for (x, y) in SplashCells.chunkyCells {
                let p = Ease.out(clamp((t - (x - 2) / 19 * 0.6 * B) / (0.3 * B)))
                guard p > 0 else { continue }
                let side = (s - 0.14) * p
                c.fill(Path(CGRect(x: x + s / 2 - side / 2, y: y + s / 2 - side / 2, width: side, height: side)), with: ink)
            }
        } else if t < 1.5 * B {
            c.fill(Self.mid, with: ink)
        } else if t < 2 * B {
            c.fill(Self.fine, with: ink)
        } else {
            c.fill(Self.head, with: ink, style: FillStyle(eoFill: true))
            c.stroke(Self.head, with: ink, style: StrokeStyle(lineWidth: 0.5, lineJoin: .miter, miterLimit: 8))
        }
    }

    /// A small wind-up, then steady exponential growth through the cat.
    private func zoomScale(_ t: Double, reach: Double) -> Double {
        let p = (t - Self.zoomAt) / Self.zoomFor
        if p <= 0 { return 1 }
        if p < 0.25 { return 1 - 0.07 * Ease.windUp(p / 0.25) }
        return 0.93 * pow(reach / 0.93, pow(min(1, (p - 0.25) / 0.75), 1.35))
    }
}

private func clamp(_ v: Double) -> Double { min(1, max(0, v)) }

/// The desktop's CSS cubic-bezier curves.
enum Ease {
    static func out(_ x: Double) -> Double { bezier(0.2, 0.8, 0.2, 1, x) }
    static func inOut(_ x: Double) -> Double { bezier(0.4, 0, 0.6, 1, x) }
    static func windUp(_ x: Double) -> Double { bezier(0.3, 0, 0.5, 1, x) }

    /// `cubic-bezier(x1, y1, x2, y2)` at progress `x`: solve for the curve's t by bisection, return its y.
    static func bezier(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
        let x = clamp(x)
        func at(_ a: Double, _ b: Double, _ t: Double) -> Double { 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t }
        var (lo, hi) = (0.0, 1.0)
        for _ in 0..<30 {
            let mid = (lo + hi) / 2
            if at(x1, x2, mid) < x { lo = mid } else { hi = mid }
        }
        return at(y1, y2, (lo + hi) / 2)
    }
}

/// Just enough SVG path syntax for the generated splash paths: M L C Z, and relative h v.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens: [String] = []
        var num = ""
        func flush() { if !num.isEmpty { tokens.append(num); num = "" } }
        for ch in d {
            if ch.isLetter { flush(); tokens.append(String(ch)) }
            else if ch == "," || ch == " " { flush() }
            else if ch == "-" && !num.isEmpty && num.last != "e" { flush(); num = "-" }
            else { num.append(ch) }
        }
        flush()
        var i = 0, cmd = "M"
        var cur = CGPoint.zero
        func next() -> Double { defer { i += 1 }; return Double(tokens[i]) ?? 0 }
        while i < tokens.count {
            if let c = tokens[i].first, c.isLetter { cmd = tokens[i]; i += 1; if cmd == "Z" { path.closeSubpath() }; continue }
            switch cmd {
            case "M": cur = CGPoint(x: next(), y: next()); path.move(to: cur); cmd = "L"
            case "L": cur = CGPoint(x: next(), y: next()); path.addLine(to: cur)
            case "C":
                let c1 = CGPoint(x: next(), y: next()), c2 = CGPoint(x: next(), y: next())
                cur = CGPoint(x: next(), y: next())
                path.addCurve(to: cur, control1: c1, control2: c2)
            case "h": cur.x += next(); path.addLine(to: cur)
            case "v": cur.y += next(); path.addLine(to: cur)
            default: i += 1
            }
        }
        return path
    }
}
