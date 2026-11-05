import SwiftUI

/// The opening animation, the end of the desktop's (apps/desktop/src/renderer/splash.ts)
/// on the iPhone: the finished cat zooms towards the viewer while the inside of
/// the cat opens as a window onto the app, until the app fills the screen. The
/// launch screen (Launch.storyboard) and the lock cover draw that same cat in the
/// same place, so the cat is there from the first frame and the zoom starts the
/// moment the app is ready (past Face ID). Drawn from elapsed time in one Canvas.
/// Reduce Motion fades the ground and the cat instead.
///
/// Coming back to the app plays only the end of it (`.resume`): the cat on the
/// lavender dissolves and the app fades in, in under half a second.
struct SplashView: View {
    enum Kind { case launch, resume }
    var kind: Kind = .launch
    /// Both kinds wait for this: the app active and not behind the lock. Until then
    /// the launch holds its first frame, the launch screen's cat.
    var ready = true
    var onDone: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start: Date?
    @State private var faded = false

    static let ground = Color(red: 0x9d / 255, green: 0x8c / 255, blue: 0xe6 / 255)
    private static let ink = Color.white
    /// The zoom, in seconds: the desktop's 1.05 beats at 120 BPM.
    private static let zoomFor = 0.525

    private static let head = SVGPath.parse(SplashCells.brandHead)
    /// The window inside the cat: the head's second subpath.
    private static let inner = SVGPath.parse(String(SplashCells.brandHead.split(separator: "Z", maxSplits: 1)[1]))

    var body: some View {
        Group {
            if kind == .resume {
                resume
            } else if reduceMotion {
                Canvas { ctx, size in draw(&ctx, size, 0) }
                    .opacity(faded ? 0 : 1)
                    .task(id: ready) {
                        guard ready else { return }
                        if !faded {
                            try? await Task.sleep(for: .milliseconds(300))
                            guard !Task.isCancelled else { return }
                            withAnimation(.easeOut(duration: 0.25)) { faded = true }
                        }
                        try? await Task.sleep(for: .milliseconds(260))
                        guard !Task.isCancelled else { return }
                        onDone()
                    }
            } else {
                // Paused while it waits (on Face ID): the first frame doesn't change.
                TimelineView(.animation(paused: start == nil)) { tl in
                    Canvas { ctx, size in draw(&ctx, size, start.map { tl.date.timeIntervalSince($0) } ?? 0) }
                }
                .task(id: ready) {
                    guard ready else { return }
                    // Started once; a brief trip to inactive (a Face ID sheet) doesn't restart it.
                    let begun = start ?? Date()
                    start = begun
                    try? await Task.sleep(for: .seconds(Self.zoomFor + 0.05 - Date().timeIntervalSince(begun)))
                    guard !Task.isCancelled else { return }
                    onDone()
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The cat where the full animation draws it, dissolving (growing, blurring and
    /// fading; only fading with Reduce Motion), then the ground fading off the app.
    private var resume: some View {
        GeometryReader { geo in
            let side = max(40, max(geo.size.width, geo.size.height) * 0.085)
            ZStack {
                Self.ground
                    .opacity(faded ? 0 : 1)
                    .animation(.easeOut(duration: 0.3).delay(0.1), value: faded)
                CatMark()
                    .foregroundStyle(Self.ink)
                    .frame(width: side, height: side)
                    .scaleEffect(faded && !reduceMotion ? 1.35 : 1)
                    .blur(radius: faded && !reduceMotion ? 8 : 0)
                    .opacity(faded ? 0 : 1)
                    .animation(.easeIn(duration: 0.3), value: faded)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
        }
        .task(id: ready) {
            guard ready else { return }
            if !faded {
                try? await Task.sleep(for: .milliseconds(60))
                guard !Task.isCancelled else { return }
                faded = true
            }
            try? await Task.sleep(for: .milliseconds(450))
            // Torn down mid-dissolve (the lock cover put back up): not done.
            guard !Task.isCancelled else { return }
            onDone()
        }
    }

    /// The frame `t` seconds into the zoom. Keep Launch.storyboard's cat (launch-cat.svg)
    /// at the same place and size: `side` wide, the logo's (12, 9) at the centre.
    private func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ t: Double) {
        let (W, H) = (size.width, size.height)
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
        let lid = 1 - Ease.inOut(clamp((t - 0.05 * Self.zoomFor) / (0.35 * Self.zoomFor)))
        if lid > 0 {
            var l = c
            l.opacity = lid
            l.fill(Self.inner, with: .color(Self.ground))
            l.stroke(Self.inner, with: .color(Self.ground), lineWidth: 0.2)
        }
        let ink = GraphicsContext.Shading.color(Self.ink)
        c.fill(Self.head, with: ink, style: FillStyle(eoFill: true))
        c.stroke(Self.head, with: ink, style: StrokeStyle(lineWidth: 0.5, lineJoin: .miter, miterLimit: 8))
    }

    /// A small wind-up, then steady exponential growth through the cat.
    private func zoomScale(_ t: Double, reach: Double) -> Double {
        let p = t / Self.zoomFor
        if p <= 0 { return 1 }
        if p < 0.25 { return 1 - 0.07 * Ease.windUp(p / 0.25) }
        return 0.93 * pow(reach / 0.93, pow(min(1, (p - 0.25) / 0.75), 1.35))
    }
}

private func clamp(_ v: Double) -> Double { min(1, max(0, v)) }

/// The desktop's CSS cubic-bezier curves.
enum Ease {
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
