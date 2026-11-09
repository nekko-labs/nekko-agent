import SwiftUI
import UIKit

extension View {
    /// Pull to refresh with Nekko in place of the system spinner: a "!" over a shocked
    /// cat, a spinning wait, then a grab, pull and smile once the reload is done.
    func pawRefreshable(action: @escaping @MainActor () async -> Void) -> some View {
        modifier(OwnedPawRefresh(action: action))
    }

    /// The same, played by the screen's toolbar mascot (`RootMascot(pull:)`) rather than
    /// a cat of its own inside the refresh control.
    func pawRefreshable(_ pull: PawPull, action: @escaping @MainActor () async -> Void) -> some View {
        modifier(PawRefreshModifier(pull: pull, action: action))
    }
}

private struct OwnedPawRefresh: ViewModifier {
    let action: @MainActor () async -> Void
    @State private var pull = PawPull()

    func body(content: Content) -> some View {
        content.pawRefreshable(pull, action: action)
    }
}

private struct PawRefreshModifier: ViewModifier {
    let pull: PawPull
    let action: @MainActor () async -> Void

    func body(content: Content) -> some View {
        content
            .refreshable { await pull.reload(action: action) }
            .background(PawRefreshProbe(pull: pull))
    }
}

/// Where the paw and the spinner are. Pure, so the timing is unit-tested.
struct PawPose: Equatable {
    /// 0 resting against the cat, 1 on the spinner.
    var reach: CGFloat = 0
    /// 1 at its own spot, 0 tucked against the cat.
    var spinner: CGFloat = 1
    /// The spinner fades once the reload is done.
    var spinnerOpacity: Double = 1
    /// The "!" over the cat's head, until the paw moves.
    var alarm = false

    /// The "!" beat before the paw moves.
    static let reachDelay = 0.3
    static let reachDuration = 0.18
    static let pullDuration = 0.28
    /// The scoop starts only after the reload finishes.
    static var pullEnd: Double { reachDuration + pullDuration }
    static let smileBeat = 0.3

    /// While loading, the paw stays tucked in and the spinner turns at its own spot.
    static func refreshing(_ t: Double, reduceMotion: Bool) -> PawPose {
        PawPose(alarm: t < reachDelay)
    }

    /// Seconds since loading completed: reach, then scoop with no pause at the grab.
    static func grabbing(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        guard t >= reachDuration else { return PawPose(reach: easeOut(t / reachDuration)) }
        return PawPose(reach: 1, spinner: 1 - easeOut((t - reachDuration) / pullDuration))
    }

    /// Seconds since the scoop finished: the spinner fades and the paw goes back.
    static func ending(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        let k = easeOut(t / smileBeat)
        return PawPose(reach: 1 - k, spinner: 0, spinnerOpacity: 1 - Double(k))
    }

    private static func easeOut(_ x: Double) -> CGFloat { CGFloat(1 - pow(1 - min(1, max(0, x)), 2)) }

    /// Where the spinner, the paw's tip and its elbow are. The reach and the pull home
    /// both curve out towards `side` (a unit vector) and the elbow bends that way, as a
    /// cat hooks a paw round something to scoop it in. The paw lands on the spinner's
    /// `side` edge, `radius` out from its centre.
    func scoop(shoulder: CGPoint, far: CGPoint, home: CGPoint, side: CGVector, radius: CGFloat) -> (center: CGPoint, tip: CGPoint, elbow: CGPoint) {
        func out(_ p: CGPoint, _ by: CGFloat) -> CGPoint { CGPoint(x: p.x + side.dx * by, y: p.y + side.dy * by) }
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        func curve(_ a: CGPoint, _ b: CGPoint, bulge: CGFloat, _ t: CGFloat) -> CGPoint {
            let c = out(mid(a, b), bulge * hypot(b.x - a.x, b.y - a.y)), u = 1 - t
            return CGPoint(x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y)
        }
        let center = curve(far, home, bulge: 0.4, 1 - spinner)
        let tip = curve(shoulder, out(center, radius * 0.85), bulge: 0.35, reach)
        let elbow = out(mid(shoulder, tip), min(10, 0.3 * hypot(tip.x - shoulder.x, tip.y - shoulder.y)))
        return (center, tip, elbow)
    }
}

/// The scroll view's pull and refresh state, fed by the probe.
@MainActor
@Observable
final class PawPull {
    var progress: CGFloat = 0
    var refreshStart: Date?
    var grabStart: Date?
    var endStart: Date?
    var smiling = false
    /// A toolbar mascot is on screen and does the grabbing.
    var mascot = false
    /// Set by the view each render; reading it redraws nothing.
    @ObservationIgnored var reduceMotion = false
    @ObservationIgnored var ink = Color.secondary

    static func motionReduced(_ environment: Bool) -> Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReduceMotion") { return true }
        #endif
        return environment
    }

    var animating: Bool { refreshStart != nil || grabStart != nil || endStart != nil }
    var shocked: Bool { refreshStart != nil && !smiling }

    func pose(at date: Date) -> PawPose {
        if let endStart { return .ending(date.timeIntervalSince(endStart), reduceMotion: reduceMotion) }
        if let grabStart { return .grabbing(date.timeIntervalSince(grabStart), reduceMotion: reduceMotion) }
        if let refreshStart { return .refreshing(date.timeIntervalSince(refreshStart), reduceMotion: reduceMotion) }
        return PawPose()
    }

    /// The same lifecycle for system pull-down, transcript pull-up, and accessible refresh.
    /// Cancellation on navigation cleans up without playing a false success smile.
    func reload(action: @MainActor () async -> Void) async {
        guard !animating, !Task.isCancelled else { return }
        let start = Date()
        refreshStart = start
        grabStart = nil
        endStart = nil
        smiling = false
        progress = 0
        defer { refreshStart = nil; grabStart = nil; endStart = nil; progress = 0 }
        await action()
        do {
            try Task.checkCancellation()
            // Even an instant/offline read gives the spinner and surprise a short beat.
            let remaining = PawPose.reachDelay - Date().timeIntervalSince(start)
            if remaining > 0 { try await Task.sleep(for: .seconds(remaining)) }
            grabStart = Date()
            try await Task.sleep(for: .seconds(PawPose.pullEnd))
            endStart = Date()
            smiling = true
            try await Task.sleep(for: .seconds(PawPose.smileBeat))
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1200))
                if refreshStart == nil { smiling = false }
            }
        } catch { smiling = false }
    }

    /// The spinner's turn: wound by the pull, then spinning.
    func turn(at date: Date) -> Double {
        animating && !reduceMotion ? date.timeIntervalSinceReferenceDate * .pi * 2 : Double(progress) * .pi * 1.5
    }
}

enum PawArt {
    static let fill = BrandColor.plum
    static let line = BrandColor.mark

    /// An eight-spoke spinner of radius 10, centred on the origin.
    static func spinner(turn: Double, ink: Color, opacity: Double = 1, in context: GraphicsContext) {
        for i in 0..<8 {
            let angle = turn + Double(i) * .pi / 4
            var spoke = Path()
            spoke.move(to: CGPoint(x: cos(angle) * 5, y: sin(angle) * 5))
            spoke.addLine(to: CGPoint(x: cos(angle) * 10, y: sin(angle) * 10))
            context.stroke(spoke, with: .color(ink.opacity((0.25 + 0.75 * Double(i) / 7) * opacity)),
                           style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
    }

    /// An arm from the shoulder, bent at the elbow, ending in a pad with two toes at
    /// `tip`. Nothing while the paw is still tucked in.
    static func paw(shoulder: CGPoint, elbow: CGPoint, tip: CGPoint, in context: GraphicsContext) {
        guard hypot(tip.x - shoulder.x, tip.y - shoulder.y) > 4 else { return }
        var arm = Path()
        arm.move(to: shoulder)
        arm.addLine(to: elbow)
        arm.addLine(to: tip)
        context.stroke(arm, with: .color(line), style: StrokeStyle(lineWidth: 7.5, lineCap: .butt, lineJoin: .round))
        context.stroke(arm, with: .color(fill), style: StrokeStyle(lineWidth: 4.5, lineCap: .butt, lineJoin: .round))
        var pad = context
        pad.translateBy(x: tip.x, y: tip.y)
        pad.rotate(by: .radians(atan2(tip.y - elbow.y, tip.x - elbow.x)))
        let rect = Path(roundedRect: CGRect(x: -4, y: -5, width: 8, height: 10), cornerRadius: 2)
        pad.fill(rect, with: .color(fill))
        pad.stroke(rect, with: .color(line), lineWidth: 1.5)
        for dy: CGFloat in [-2.5, 1.5] {
            pad.fill(Path(CGRect(x: 1, y: dy, width: 2, height: 1)), with: .color(line))
        }
    }

    /// A tiny "!" whose top is at `top`, `height` tall.
    static func alarm(x: CGFloat, top: CGFloat, height: CGFloat, in context: GraphicsContext) {
        let w = height * 0.28
        for rect in [CGRect(x: x - w / 2, y: top, width: w, height: height * 0.62),
                     CGRect(x: x - w / 2, y: top + height - w, width: w, height: w)] {
            context.fill(Path(rect), with: .color(fill))
            context.stroke(Path(rect), with: .color(line), lineWidth: 1)
        }
    }
}

/// What the refresh control shows on a screen without a toolbar mascot: the
/// mascot at the top, with the paw emerging from under its right cheek and
/// reaching down to the spinner, matching the toolbar mascot's grab. With a
/// toolbar mascot, nothing: the mascot draws the spinner beside itself.
struct PawRefreshArt: View {
    var pull: PawPull
    /// The whole control. Tall enough for the "!" above the cat, the cat itself,
    /// and the spinner swinging in below it. The refresh control is roughly 60 pt
    /// tall when refreshing, so the extra ~16 pt we need is let through by the
    /// probe's clipsToBounds = false.
    static let size = CGSize(width: 110, height: 76)
    /// Room above the cat for the "!".
    static let lift: CGFloat = 8

    var body: some View {
        TimelineView(.animation(paused: !pull.animating || pull.reduceMotion)) { timeline in
            let pose = pull.pose(at: timeline.date)
            let turn = pull.turn(at: timeline.date)
            ZStack(alignment: .top) {
                Canvas { context, size in draw(pose, turn: turn, size: size, in: &context) }
                    .frame(width: Self.size.width, height: Self.size.height)
                if !pull.mascot {
                    PixelCat(happy: pull.smiling, shocked: pull.shocked,
                             blink: !pull.animating && !pull.smiling && pull.progress < 1)
                        .frame(width: 36, height: 36)
                        .offset(y: Self.lift)
                }
            }
            .frame(width: Self.size.width, height: Self.size.height)
            .opacity(pull.animating ? 1 : min(1, Double(pull.progress) * 1.5))
        }
        .accessibilityHidden(true)
    }

    private func draw(_ pose: PawPose, turn: Double, size: CGSize, in context: inout GraphicsContext) {
        guard !pull.mascot else { return }
        // Mascot sits top-center, lifted by `lift`; the arm comes out from behind
        // its right cheek and the spinner swings in from below and to the right.
        let (cat, top) = (size.width / 2, Self.lift)
        let shoulder = CGPoint(x: cat + 7, y: top + 26)
        let at = pose.scoop(shoulder: shoulder,
                            far: CGPoint(x: cat + 10, y: top + 48),
                            home: CGPoint(x: cat + 22, y: top + 30),
                            side: CGVector(dx: 1, dy: 0), radius: 11)
        if pose.alarm { PawArt.alarm(x: cat + 14, top: top - 8, height: 10, in: context) }
        var spinner = context
        spinner.translateBy(x: at.center.x, y: at.center.y)
        spinner.scaleBy(x: 1.2, y: 1.2)
        PawArt.spinner(turn: turn, ink: pull.ink, opacity: pose.spinnerOpacity, in: spinner)
        PawArt.paw(shoulder: shoulder, elbow: at.elbow, tip: at.tip, in: context)
    }
}

/// The toolbar mascot's spinner, paw and "!", drawn behind the cat (so the arm comes
/// out from under its cheek) in a canvas hanging from just above its top centre.
struct MascotPawLayer: View {
    var pull: PawPull
    static let size = CGSize(width: 160, height: 120)
    /// Room above the mascot for the "!".
    static let lift: CGFloat = 14

    var body: some View {
        TimelineView(.animation(paused: !pull.animating || pull.reduceMotion)) { timeline in
            Canvas { context, size in
                guard pull.animating || pull.progress > 0 else { return }
                let pose = pull.pose(at: timeline.date)
                let (cat, top) = (size.width / 2, Self.lift)
                // The mascot is 44 x 44: its right cheek, under the face's edge, and home
                // tucked behind that cheek. The spinner starts just below and to the right.
                let shoulder = CGPoint(x: cat + 9, y: top + 31)
                let at = pose.scoop(shoulder: shoulder, far: CGPoint(x: cat + 14, y: top + 58), home: CGPoint(x: cat + 26, y: top + 35),
                                    side: CGVector(dx: 1, dy: 0), radius: 14)
                var spinner = context
                spinner.translateBy(x: at.center.x, y: at.center.y)
                spinner.scaleBy(x: 1.4, y: 1.4)
                let fade = pull.animating ? pose.spinnerOpacity : min(1, Double(pull.progress) * 1.5)
                PawArt.spinner(turn: pull.turn(at: timeline.date), ink: pull.ink, opacity: fade, in: spinner)
                PawArt.paw(shoulder: shoulder, elbow: at.elbow, tip: at.tip, in: context)
                // Over the right ear.
                if pose.alarm { PawArt.alarm(x: cat + 17, top: top - 6, height: 12, in: context) }
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .offset(y: -Self.lift)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Finds the scroll view `.refreshable` gave a UIRefreshControl, clears the system
/// spinner and hosts the art inside the control instead.
private struct PawRefreshProbe: UIViewRepresentable {
    let pull: PawPull
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> PawProbeView { PawProbeView(pull: pull) }

    func updateUIView(_ view: PawProbeView, context: Context) {
        view.pull.ink = palette.inkSoft
        view.pull.reduceMotion = PawPull.motionReduced(reduceMotion)
    }
}

final class PawProbeView: UIView {
    let pull: PawPull
    private static let tag = 0x9A3
    private weak var control: UIRefreshControl?
    private var host: UIHostingController<PawRefreshArt>?
    private var observation: NSKeyValueObservation?

    init(pull: PawPull) {
        self.pull = pull
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        // A deinit isn't on the main actor; the hosted view is taken down there.
        if let host { Task { @MainActor in host.view.removeFromSuperview() } }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attach(tries: 10)
    }

    /// SwiftUI sets the control after the first layout, so look again for a moment.
    private func attach(tries: Int) {
        guard control == nil, window != nil else { return }
        guard let scroll = nearestScrollView(), let control = scroll.refreshControl else {
            if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.attach(tries: tries - 1) } }
            return
        }
        self.control = control
        control.tintColor = .clear
        // The vertical layout stacks the cat over the spinner, so the content
        // can be taller than the control's visible bounds; the control and the
        // host both let the overflow show instead of cropping the cat's head off.
        control.clipsToBounds = false
        // Kept so the hosted view keeps updating; the control only holds its view.
        let host = UIHostingController(rootView: PawRefreshArt(pull: pull))
        host.view.tag = Self.tag
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        host.view.accessibilityElementsHidden = true
        host.view.clipsToBounds = false
        host.view.frame = control.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        control.addSubview(host.view)
        self.host = host
        // UIKit changes the offset, and so reports it, on the main thread.
        observation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated { self?.update(scroll) }
        }
    }

    private func update(_ scroll: UIScrollView) {
        guard let control else { return }
        control.tintColor = .clear
        // Only a finger's pull counts: the page springing back after a refresh must not
        // bring the spinner back.
        let pulled = scroll.isTracking ? -(scroll.contentOffset.y + scroll.adjustedContentInset.top) : 0
        if pull.progress != min(1, max(0, pulled / 80)) { pull.progress = min(1, max(0, pulled / 80)) }

    }

    /// The closest unclaimed scroll view with a refresh control: siblings first, then
    /// further out, so a screen never takes another screen's control.
    private func nearestScrollView() -> UIScrollView? {
        func search(_ view: UIView, depth: Int) -> UIScrollView? {
            for case let scroll as UIScrollView in view.subviews {
                if let control = scroll.refreshControl, !control.subviews.contains(where: { $0.tag == Self.tag }) { return scroll }
            }
            guard depth > 0 else { return nil }
            for sub in view.subviews { if let found = search(sub, depth: depth - 1) { return found } }
            return nil
        }
        var ancestor = superview
        while let view = ancestor {
            if let found = search(view, depth: 6) { return found }
            ancestor = view.superview
        }
        return nil
    }
}
