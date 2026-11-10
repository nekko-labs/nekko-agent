#if DEBUG
import SwiftUI
import UIKit

@MainActor enum StreamingFollowTrace {
    static var events: [String] = []
    static func record(_ event: String) {
        events.append(String(format: "%.3f ", ProcessInfo.processInfo.systemUptime) + event)
        if events.count > 200 { events.removeFirst(events.count - 200) }
    }
}

/// Fixture-only sampling, outside the transcript's layout. Records backward jumps
/// during append-only output before the UI test deliberately scrolls into history.
struct StreamingGeometryProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isAccessibilityElement = true
        view.accessibilityIdentifier = "stream.maxBackward"
        view.accessibilityLabel = "Largest backward streaming offset"
        view.accessibilityValue = "pending"
        context.coordinator.sample(view)
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }
    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) { coordinator.task?.cancel() }

    @MainActor final class Coordinator {
        var task: Task<Void, Never>?
        func sample(_ view: UIView) {
            task = Task { @MainActor [weak view] in
                let started = ProcessInfo.processInfo.systemUptime
                try? await Task.sleep(for: .seconds(5))
                var previous: CGFloat?
                var largest: CGFloat = 0
                var count = 0
                var trace: [String] = []
                StreamingFollowTrace.events = []
                for _ in 0..<300 {
                    guard !Task.isCancelled, let view else { return }
                    if let window = view.window, let scroll = Self.scrolls(window).max(by: {
                        $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height
                    }) {
                        let y = scroll.contentOffset.y
                        trace.append(String(format: "sample=%d elapsed=%.3f y=%.3f height=%.3f viewport=%.3f insetTop=%.3f insetBottom=%.3f",
                                            count, ProcessInfo.processInfo.systemUptime - started, Double(y), Double(scroll.contentSize.height), Double(scroll.bounds.height),
                                            Double(scroll.adjustedContentInset.top), Double(scroll.adjustedContentInset.bottom)))
                        if let previous { largest = max(largest, previous - y) }
                        previous = y
                        count += 1
                    }
                    try? await Task.sleep(for: .milliseconds(30))
                }
                view?.accessibilityLabel = trace.joined(separator: "; ")
                view?.accessibilityValue = count > 250 ? String(format: "%.3f", Double(largest)) : "missing samples"
                // Expose follow intent after measurement, during reader gestures.
                for _ in 0..<600 {
                    guard !Task.isCancelled, let view else { return }
                    view.accessibilityLabel = trace.joined(separator: "; ") + " FOLLOW_EVENTS " + StreamingFollowTrace.events.joined(separator: "; ")
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
        }
        private static func scrolls(_ view: UIView) -> [UIScrollView] {
            let own = (view as? UIScrollView).map { [$0] } ?? []
            return own + view.subviews.flatMap { scrolls($0) }
        }
    }
}
#endif
