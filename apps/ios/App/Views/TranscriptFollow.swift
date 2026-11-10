import SwiftUI

/// Follow laid-out growth, not token notifications delivered before Text has measured.
/// Lazy row visibility is not reader intent: a growing row can evict the end sentinel.
struct TranscriptFollow: ViewModifier {
    @Binding var atBottom: Bool
    let readerScrolled: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.modifier(Measured(atBottom: $atBottom, readerScrolled: readerScrolled))
        } else { content }
    }

    @available(iOS 18.0, *)
    private struct Measured: ViewModifier {
        @Binding var atBottom: Bool
        let readerScrolled: () -> Void
        @State private var readerMoving = false
        @State private var position = ScrollPosition(edge: .bottom)

        private struct Size: Equatable {
            let height: CGFloat
            let distance: CGFloat
        }

        func body(content: Content) -> some View {
            content
                .scrollPosition($position)
                .onScrollPhaseChange { oldPhase, phase in
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-refreshStream") {
                        print("STREAM_PHASE old=\(oldPhase) new=\(phase) atBottom=\(atBottom)")
                    }
                    #endif
                    readerMoving = phase == .tracking || phase == .interacting || phase == .decelerating
                    if readerMoving { readerScrolled() }
                }
                .onScrollGeometryChange(for: Size.self) { geometry in
                    Size(height: geometry.contentSize.height,
                         distance: geometry.contentSize.height + geometry.contentInsets.bottom
                            - geometry.contentOffset.y - geometry.containerSize.height)
                } action: { old, new in
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-refreshStream") {
                        print("STREAM_FOLLOW height=\(new.height) distance=\(new.distance) readerMoving=\(readerMoving) atBottom=\(atBottom)")
                    }
                    #endif
                    if readerMoving {
                        atBottom = new.distance <= 24
                    } else if atBottom && new.height != old.height {
                        var transaction = Transaction(animation: nil)
                        transaction.disablesAnimations = true
                        // Use the measured scroll-content edge, not a lazy sentinel whose
                        // estimated position can move backward as rows are realised.
                        withTransaction(transaction) { position.scrollTo(edge: .bottom) }
                    } else if new.distance <= 24 {
                        atBottom = true
                    }
                }
        }
    }
}
