import SwiftUI

/// Follow laid-out growth, not token notifications delivered before Text has measured.
/// Lazy row visibility is not reader intent: a growing row can evict the end sentinel.
struct TranscriptFollow: ViewModifier {
    @Binding var atBottom: Bool
    let follow: () -> Void
    let readerScrolled: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.modifier(Measured(atBottom: $atBottom, follow: follow, readerScrolled: readerScrolled))
        } else { content }
    }

    @available(iOS 18.0, *)
    private struct Measured: ViewModifier {
        @Binding var atBottom: Bool
        let follow: () -> Void
        let readerScrolled: () -> Void
        @State private var readerMoving = false

        private struct Size: Equatable {
            let height: CGFloat
            let distance: CGFloat
        }

        func body(content: Content) -> some View {
            content
                .onScrollPhaseChange { _, phase in
                    readerMoving = phase == .tracking || phase == .interacting || phase == .decelerating
                    if readerMoving { readerScrolled() }
                }
                .onScrollGeometryChange(for: Size.self) { geometry in
                    Size(height: geometry.contentSize.height,
                         distance: geometry.contentSize.height + geometry.contentInsets.bottom
                            - geometry.contentOffset.y - geometry.containerSize.height)
                } action: { old, new in
                    if readerMoving {
                        atBottom = new.distance <= 24
                    } else if atBottom && new.height != old.height {
                        var transaction = Transaction(animation: nil)
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { follow() }
                    } else if new.distance <= 24 {
                        atBottom = true
                    }
                }
        }
    }
}
