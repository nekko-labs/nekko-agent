import SwiftUI
import UIKit

extension View {
    /// A transcript refreshes from its newest message, never from its history's top.
    func pawRefreshableFromEnd(_ pull: PawPull, action: @escaping @MainActor () async -> Void) -> some View {
        background(PawBottomRefreshProbe(pull: pull, action: action))
            .accessibilityAction(named: Text("Refresh")) {
                Task { await pull.reload(action: action) }
            }
    }
}

/// UIKit's refresh control only supports the top. Measure the actual scroll view's
/// bottom bounce instead; do not reverse the transcript or intercept its gestures.
struct PawBottomEdge {
    static let threshold: CGFloat = 80

    static func progress(offset: CGFloat, content: CGFloat, viewport: CGFloat, top: CGFloat, bottom: CGFloat) -> CGFloat {
        let end = max(-top, content - viewport + bottom)
        return min(1, max(0, (offset - end) / threshold))
    }
}

private struct PawBottomRefreshProbe: UIViewRepresentable {
    let pull: PawPull
    let action: @MainActor () async -> Void
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeUIView(context: Context) -> PawBottomProbeView { PawBottomProbeView(pull: pull, action: action) }
    func updateUIView(_ view: PawBottomProbeView, context: Context) {
        pull.ink = palette.inkSoft
        pull.reduceMotion = PawPull.motionReduced(reduceMotion)
        view.action = action
    }
    static func dismantleUIView(_ view: PawBottomProbeView, coordinator: ()) { view.detach() }
}

final class PawBottomProbeView: UIView {
    let pull: PawPull
    var action: @MainActor () async -> Void
    private weak var scroll: UIScrollView?
    private var observation: NSKeyValueObservation?
    private var refresh: Task<Void, Never>?

    init(pull: PawPull, action: @escaping @MainActor () async -> Void) {
        self.pull = pull
        self.action = action
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { detach() } else { attach(tries: 10) }
    }

    private func attach(tries: Int) {
        guard scroll == nil, window != nil else { return }
        guard let found = nearestScrollView() else {
            if tries > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.attach(tries: tries - 1) } }
            return
        }
        scroll = found
        found.alwaysBounceVertical = true // Also works in an empty or short chat.
        found.panGestureRecognizer.addTarget(self, action: #selector(panChanged))
        observation = found.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated { self?.update(scroll) }
        }
    }

    func detach() {
        scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged))
        observation = nil
        scroll = nil
        refresh?.cancel()
        refresh = nil
        pull.progress = 0
    }

    private func update(_ scroll: UIScrollView) {
        guard !pull.animating, scroll.panGestureRecognizer.state == .changed else { return }
        pull.progress = PawBottomEdge.progress(offset: scroll.contentOffset.y, content: scroll.contentSize.height,
                                               viewport: scroll.bounds.height, top: scroll.adjustedContentInset.top,
                                               bottom: scroll.adjustedContentInset.bottom)
    }

    @objc private func panChanged(_ pan: UIPanGestureRecognizer) {
        guard let scroll else { return }
        switch pan.state {
        case .changed: update(scroll)
        case .ended:
            let armed = pull.progress >= 1 && !pull.animating
            pull.progress = 0
            guard armed else { return }
            refresh = Task { await pull.reload(action: action) }
        case .cancelled, .failed: pull.progress = 0
        default: break
        }
    }

    private func nearestScrollView() -> UIScrollView? {
        // A background may be inside the scroll view or beside its hosting view.
        func search(_ view: UIView, depth: Int) -> UIScrollView? {
            if let scroll = view as? UIScrollView { return scroll }
            guard depth > 0 else { return nil }
            for child in view.subviews { if let found = search(child, depth: depth - 1) { return found } }
            return nil
        }
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? UIScrollView { return scroll }
            if let found = search(view, depth: 4) { return found }
            ancestor = view.superview
        }
        return nil
    }
}
