import SwiftUI
import UIKit

extension View {
    /// Pull to refresh with Nekko in place of the system spinner: the cat slaps the
    /// spinner twice, holds it while the reload runs, then drags it home and the page
    /// follows it back.
    func pawRefreshable(action: @escaping @Sendable () async -> Void) -> some View {
        modifier(PawRefreshModifier(action: action))
    }
}

private struct PawRefreshModifier: ViewModifier {
    let action: @Sendable () async -> Void
    @StateObject private var pull = PawPull()

    func body(content: Content) -> some View {
        content
            .refreshable { [pull] in
                let start = ContinuousClock.now
                await action()
                // Long enough for both slaps, however fast the reload is.
                try? await Task.sleep(until: start + .milliseconds(Int(PawPose.slapsEnd * 1000)), clock: .continuous)
                // The drag home plays before the refresh ends: once it ends the page
                // closes over the control at once.
                await MainActor.run { pull.endStart = Date() }
                try? await Task.sleep(for: .milliseconds(Int(PawPose.pullDuration * 1000)))
            }
            .background(PawRefreshProbe(pull: pull))
    }
}

/// Where the paw and the spinner are. Pure, so the timing is unit-tested.
struct PawPose: Equatable {
    /// 0 resting against the cat, 1 on the spinner.
    var reach: CGFloat = 0
    /// 1 at its own spot, 0 tucked against the cat.
    var spinnerX: CGFloat = 1
    /// 0 round, 1 flattened by a slap.
    var squash: CGFloat = 0

    static let slapTimes = [0.15, 0.4]
    static let swing = 0.12
    static let slapsEnd = 0.6
    static let pullDuration = 0.35

    /// Seconds since the refresh began.
    static func refreshing(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        let (first, second) = (slapTimes[0], slapTimes[1])
        // Out and back for the first slap; the second one stays on the spinner.
        let reach = t >= second ? 1 : max(0, 1 - abs(t - first) / swing, 1 - (second - t) / swing)
        let squash = slapTimes.map { t >= $0 ? max(0, 1 - (t - $0) / 0.15) : 0 }.max() ?? 0
        return PawPose(reach: reach, spinnerX: 1, squash: squash)
    }

    /// Seconds since the reload finished and the drag home began.
    static func ending(_ t: Double, reduceMotion: Bool) -> PawPose {
        guard !reduceMotion else { return PawPose() }
        let k = 1 - pow(1 - min(1, max(0, t) / pullDuration), 2)
        return PawPose(reach: 1, spinnerX: 1 - k, squash: 0)
    }
}

/// The scroll view's pull and refresh state, fed by the probe.
final class PawPull: ObservableObject {
    @Published var progress: CGFloat = 0
    @Published var refreshStart: Date?
    @Published var endStart: Date?
    var reduceMotion = false
    var ink = Color.secondary

    var animating: Bool { refreshStart != nil || endStart != nil }

    func pose(at date: Date) -> PawPose {
        if let endStart { return .ending(date.timeIntervalSince(endStart), reduceMotion: reduceMotion) }
        if let refreshStart { return .refreshing(date.timeIntervalSince(refreshStart), reduceMotion: reduceMotion) }
        return PawPose()
    }
}

/// Nekko, its paw and the spinner it plays with, drawn in a 120 x 44 box at 1.4x.
struct PawRefreshArt: View {
    @ObservedObject var pull: PawPull
    private let fill = Color(red: 16/255, green: 23/255, blue: 20/255)
    private let line = Color(red: 242/255, green: 241/255, blue: 233/255)

    var body: some View {
        TimelineView(.animation(paused: !pull.animating || pull.reduceMotion)) { timeline in
            let pose = pull.pose(at: timeline.date)
            let turn = pull.animating && !pull.reduceMotion
                ? timeline.date.timeIntervalSinceReferenceDate * .pi * 2
                : Double(pull.progress) * .pi * 1.5
            ZStack(alignment: .leading) {
                Canvas { context, _ in draw(pose, turn: turn, in: &context) }
                PixelCat(happy: pull.endStart != nil, blink: pull.refreshStart == nil && pull.endStart == nil && pull.progress < 1)
                    .frame(width: 40, height: 40)
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
        let cx = 58 + pose.spinnerX * 46
        let tip = 37 + pose.reach * (cx - 12 - 37)
        // The arm comes out from behind the cat's cheek; the pad has two toes.
        let arm = Path(CGRect(x: 30, y: y - 3, width: max(0, tip - 36), height: 6))
        context.fill(arm, with: .color(fill))
        context.stroke(arm, with: .color(line), lineWidth: 1.5)
        let pad = Path(roundedRect: CGRect(x: tip - 8, y: y - 5, width: 8, height: 10), cornerRadius: 2)
        context.fill(pad, with: .color(fill))
        context.stroke(pad, with: .color(line), lineWidth: 1.5)
        for dy: CGFloat in [-2.5, 1.5] {
            context.fill(Path(CGRect(x: tip - 3, y: y + dy, width: 2, height: 1)), with: .color(line))
        }
        // The spinner, flattened and shoved by each slap.
        var spinner = context
        spinner.translateBy(x: cx + 4 * pose.squash, y: y)
        spinner.scaleBy(x: 1 - 0.35 * pose.squash, y: 1 + 0.15 * pose.squash)
        for i in 0..<8 {
            let angle = turn + Double(i) * .pi / 4
            var spoke = Path()
            spoke.move(to: CGPoint(x: cos(angle) * 5, y: sin(angle) * 5))
            spoke.addLine(to: CGPoint(x: cos(angle) * 10, y: sin(angle) * 10))
            spinner.stroke(spoke, with: .color(pull.ink.opacity(0.25 + 0.75 * Double(i) / 7)),
                           style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
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
