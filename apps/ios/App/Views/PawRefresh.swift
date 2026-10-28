import SwiftUI
import UIKit

extension View {
    /// Pull to refresh with Nekko in place of the system spinner: the cat looks shocked,
    /// reaches out, pulls the spinner home and smiles.
    func pawRefreshable(action: @escaping @Sendable () async -> Void) -> some View {
        modifier(OwnedPawRefresh(action: action))
    }

    /// The same, played by the screen's toolbar mascot (`RootMascot(pull:)`) rather than
    /// a cat of its own inside the refresh control.
    func pawRefreshable(_ pull: PawPull, action: @escaping @Sendable () async -> Void) -> some View {
        modifier(PawRefreshModifier(pull: pull, action: action))
    }
}

private struct OwnedPawRefresh: ViewModifier {
    let action: @Sendable () async -> Void
    @StateObject private var pull = PawPull()

    func body(content: Content) -> some View {
        content.pawRefreshable(pull, action: action)
    }
}

private struct PawRefreshModifier: ViewModifier {
    let pull: PawPull
    let action: @Sendable () async -> Void

    func body(content: Content) -> some View {
        content
            .refreshable { [pull] in
                await MainActor.run { pull.smiling = false }
                let start = ContinuousClock.now
                await action()
                // Long enough for the reach, however fast the reload is.
                try? await Task.sleep(until: start + .milliseconds(Int(PawPose.reachEnd * 1000)), clock: .continuous)
                // The pull home plays before the refresh ends: once it ends the page
                // closes over the control at once.
                await MainActor.run { pull.endStart = Date() }
                try? await Task.sleep(for: .milliseconds(Int(PawPose.pullDuration * 1000)))
                await MainActor.run { pull.smiling = true }
                try? await Task.sleep(for: .milliseconds(Int(PawPose.smileBeat * 1000)))
                // The toolbar mascot keeps smiling a moment after the page closes.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(1200))
                    if pull.refreshStart == nil { pull.smiling = false }
                }
            }
            .background(PawRefreshProbe(pull: pull))
    }
}

/// Where the paw and the spinner are. Pure, so the timing is unit-tested.
struct PawPose: Equatable {
    /// 0 resting against the cat, 1 on the spinner.
    var reach: CGFloat = 0
    /// 1 at its own spot, 0 tucked against the cat.
    var spinner: CGFloat = 1
    /// The spinner fades once it is home.
    var spinnerOpacity: Double = 1

    /// The shocked beat before the paw moves.
    static let reachDelay = 0.15
    static let reachDuration = 0.25
    static var reachEnd: Double { reachDelay + reachDuration }
    static let pullDuration = 0.35
    static let smileBeat = 0.3

    /// Seconds since the refresh began.
    static func refreshing(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        return PawPose(reach: easeOut((t - reachDelay) / reachDuration))
    }

    /// Seconds since the reload finished and the pull home began.
    static func ending(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        return PawPose(reach: 1, spinner: 1 - easeOut(t / pullDuration),
                       spinnerOpacity: 1 - Double(easeOut((t - pullDuration) / smileBeat)))
    }

    private static func easeOut(_ x: Double) -> CGFloat { CGFloat(1 - pow(1 - min(1, max(0, x)), 2)) }
}

/// The scroll view's pull and refresh state, fed by the probe.
final class PawPull: ObservableObject {
    @Published var progress: CGFloat = 0
    @Published var refreshStart: Date?
    @Published var endStart: Date?
    @Published var smiling = false
    /// The spinner's centre in window coordinates, for a toolbar mascot to reach.
    @Published var spinnerPoint: CGPoint?
    /// A toolbar mascot is on screen and does the grabbing.
    @Published var mascot = false
    var reduceMotion = false
    var ink = Color.secondary

    var animating: Bool { refreshStart != nil || endStart != nil }
    var shocked: Bool { refreshStart != nil && !smiling }

    func pose(at date: Date) -> PawPose {
        if let endStart { return .ending(date.timeIntervalSince(endStart), reduceMotion: reduceMotion) }
        if let refreshStart { return .refreshing(date.timeIntervalSince(refreshStart), reduceMotion: reduceMotion) }
        return PawPose()
    }

    /// The spinner's turn: wound by the pull, then spinning.
    func turn(at date: Date) -> Double {
        animating && !reduceMotion ? date.timeIntervalSinceReferenceDate * .pi * 2 : Double(progress) * .pi * 1.5
    }
}

enum PawArt {
    static let fill = Color(red: 16/255, green: 23/255, blue: 20/255)
    static let line = Color(red: 242/255, green: 241/255, blue: 233/255)

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

    /// An arm from `from` to `to`, ending in a pad with two toes.
    static func paw(from: CGPoint, to: CGPoint, in context: GraphicsContext) {
        var arm = Path()
        arm.move(to: from)
        arm.addLine(to: to)
        context.stroke(arm, with: .color(line), style: StrokeStyle(lineWidth: 7.5, lineCap: .butt))
        context.stroke(arm, with: .color(fill), style: StrokeStyle(lineWidth: 4.5, lineCap: .butt))
        var pad = context
        pad.translateBy(x: to.x, y: to.y)
        pad.rotate(by: .radians(atan2(to.y - from.y, to.x - from.x)))
        let rect = Path(roundedRect: CGRect(x: -4, y: -5, width: 8, height: 10), cornerRadius: 2)
        pad.fill(rect, with: .color(fill))
        pad.stroke(rect, with: .color(line), lineWidth: 1.5)
        for dy: CGFloat in [-2.5, 1.5] {
            pad.fill(Path(CGRect(x: 1, y: dy, width: 2, height: 1)), with: .color(line))
        }
    }
}

/// What the refresh control shows: the spinner, and on a screen without a toolbar
/// mascot, a cat of its own and its paw, in a 120 x 44 box at 1.4x.
struct PawRefreshArt: View {
    @ObservedObject var pull: PawPull

    var body: some View {
        TimelineView(.animation(paused: !pull.animating || pull.reduceMotion)) { timeline in
            let pose = pull.pose(at: timeline.date)
            let turn = pull.turn(at: timeline.date)
            ZStack(alignment: .leading) {
                if pull.mascot {
                    // The toolbar mascot draws the spinner once it has it.
                    Canvas { context, size in
                        guard !pull.animating else { return }
                        var spinner = context
                        spinner.translateBy(x: size.width / 2, y: size.height / 2)
                        PawArt.spinner(turn: turn, ink: pull.ink, in: spinner)
                    }
                } else {
                    Canvas { context, _ in draw(pose, turn: turn, in: &context) }
                    PixelCat(happy: pull.smiling, shocked: pull.shocked,
                             blink: !pull.animating && !pull.smiling && pull.progress < 1)
                        .frame(width: 40, height: 40)
                }
            }
            .frame(width: 120, height: 44)
            .scaleEffect(1.4)
            .frame(width: 168, height: 62)
            .opacity(pull.animating ? 1 : min(1, Double(pull.progress) * 1.5))
        }
        .accessibilityHidden(true)
    }

    private func draw(_ pose: PawPose, turn: Double, in context: inout GraphicsContext) {
        let y: CGFloat = 27
        let cx = 58 + pose.spinner * 46
        let tip = 37 + pose.reach * (cx - 12 - 37)
        // The arm comes out from behind the cat's cheek.
        if tip > 37 { PawArt.paw(from: CGPoint(x: 33, y: y), to: CGPoint(x: tip - 4, y: y), in: context) }
        var spinner = context
        spinner.translateBy(x: cx, y: y)
        PawArt.spinner(turn: turn, ink: pull.ink, opacity: pose.spinnerOpacity, in: spinner)
    }
}

/// The toolbar mascot's paw and the spinner it holds, drawn below its chin in window
/// coordinates taken from the refresh control.
struct MascotPawLayer: View {
    @ObservedObject var pull: PawPull
    /// The mascot's frame in window coordinates.
    let mascot: CGRect
    static let size = CGSize(width: 160, height: 200)

    var body: some View {
        TimelineView(.animation(paused: !pull.animating || pull.reduceMotion)) { timeline in
            Canvas { context, size in
                guard pull.animating, let target = pull.spinnerPoint, mascot != .zero else { return }
                let pose = pull.pose(at: timeline.date)
                // Window coordinates into this canvas, which hangs from the mascot's top centre.
                let origin = CGPoint(x: mascot.midX - size.width / 2, y: mascot.minY)
                let chin = CGPoint(x: size.width / 2, y: mascot.height * 0.78)
                let home = CGPoint(x: chin.x, y: chin.y + 16)
                let far = CGPoint(x: target.x - origin.x, y: target.y - origin.y)
                let center = CGPoint(x: home.x + (far.x - home.x) * pose.spinner, y: home.y + (far.y - home.y) * pose.spinner)
                // The pad lands on the spinner's top, 1.4x as drawn in the control.
                let grab = CGPoint(x: center.x, y: center.y - 14)
                let tip = CGPoint(x: chin.x + (grab.x - chin.x) * pose.reach, y: chin.y + (grab.y - chin.y) * pose.reach)
                var spinner = context
                spinner.translateBy(x: center.x, y: center.y)
                spinner.scaleBy(x: 1.4, y: 1.4)
                PawArt.spinner(turn: pull.turn(at: timeline.date), ink: pull.ink, opacity: pose.spinnerOpacity, in: spinner)
                if tip.y - chin.y > 4 { PawArt.paw(from: chin, to: tip, in: context) }
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
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
        view.pull.reduceMotion = reduceMotion
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

    deinit { host?.view.removeFromSuperview() }

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
        // Kept so the hosted view keeps updating; the control only holds its view.
        let host = UIHostingController(rootView: PawRefreshArt(pull: pull))
        host.view.tag = Self.tag
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        host.view.accessibilityElementsHidden = true
        host.view.frame = control.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        control.addSubview(host.view)
        self.host = host
        observation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            self?.update(scroll)
        }
    }

    private func update(_ scroll: UIScrollView) {
        guard let control else { return }
        control.tintColor = .clear
        let pulled = -(scroll.contentOffset.y + scroll.adjustedContentInset.top)
        if pull.progress != min(1, max(0, pulled / 80)) { pull.progress = min(1, max(0, pulled / 80)) }
        if pull.mascot {
            let point = control.convert(CGPoint(x: control.bounds.midX, y: control.bounds.midY), to: nil)
            if pull.spinnerPoint != point { pull.spinnerPoint = point }
        }
        if control.isRefreshing, pull.refreshStart == nil {
            pull.refreshStart = Date()
            pull.endStart = nil
        } else if !control.isRefreshing, pull.refreshStart != nil {
            pull.refreshStart = nil
            pull.endStart = nil
        }
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
