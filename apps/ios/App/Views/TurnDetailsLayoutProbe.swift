#if DEBUG
import SwiftUI

/// UI-test-only readings from the actual footer, not its combined accessibility
/// frame. Never writes files, changes the width proposal, or reads real chats.
@MainActor @Observable
final class TurnDetailsLayoutProbe {
    static let shared = TurnDetailsLayoutProbe()
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-turnDetailsMeasureLayout") }
    static var rendersLines: Bool { ProcessInfo.processInfo.arguments.contains("-turnDetailsRenderLayout") }
    static var disablesSelection: Bool { ProcessInfo.processInfo.arguments.contains("-turnDetailsNoSelection") }

    var frames: [String: CGRect] = [:]
    var lines: [CGRect] = []
    var truncated = true
    var dynamicType = ""
    var scale: CGFloat = 0

    var json: String {
        func rect(_ r: CGRect) -> [CGFloat] { [r.minX, r.minY, r.width, r.height] }
        let values: [String: Any] = [
            "frames": frames.mapValues(rect), "lines": lines.map(rect),
            "truncated": truncated, "dynamicType": dynamicType, "scale": scale,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

/// Observing resolved geometry does not participate in layout.
struct TurnDetailsMeasureFrame: ViewModifier {
    let name: String
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.displayScale) private var scale

    func body(content: Content) -> some View {
        if TurnDetailsLayoutProbe.enabled {
            content.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                let probe = TurnDetailsLayoutProbe.shared
                probe.frames[name] = frame
                probe.dynamicType = String(describing: dynamicType)
                probe.scale = scale
            }
        } else { content }
    }
}

struct TurnDetailsProbeSelection: ViewModifier {
    func body(content: Content) -> some View {
        if TurnDetailsLayoutProbe.enabled && TurnDetailsLayoutProbe.disablesSelection {
            content.textSelection(.disabled)
        } else { content.textSelection(.enabled) }
    }
}

/// Pass-through rendering, only in a second diagnostic launch. The UI test first
/// measures the normal selectable Text, then requires identical geometry with
/// this renderer before trusting its line count/bounds/truncation readings.
struct TurnDetailsMeasureText: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), TurnDetailsLayoutProbe.enabled && TurnDetailsLayoutProbe.rendersLines {
            content.textRenderer(TurnDetailsLineProbe())
        } else { content }
    }
}

@available(iOS 18.0, *)
private struct TurnDetailsLineProbe: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let lines = layout.map { $0.typographicBounds.rect }
        let truncated = layout.isTruncated
        for line in layout { context.draw(line) }
        // Do not mutate observable state during drawing, and do not schedule a
        // new layout when an unchanged frame is drawn again.
        Task { @MainActor in
            let probe = TurnDetailsLayoutProbe.shared
            if probe.lines != lines { probe.lines = lines }
            if probe.truncated != truncated { probe.truncated = truncated }
        }
    }
}

struct TurnDetailsProbeReadout: View {
    private var probe: TurnDetailsLayoutProbe { .shared }
    var body: some View {
        if TurnDetailsLayoutProbe.enabled {
            Text("Layout probe").font(.system(size: 1)).frame(width: 1, height: 1).opacity(0.01)
                .accessibilityIdentifier("turn.details.layout")
                .accessibilityLabel("Layout probe")
                .accessibilityValue(probe.json)
                .allowsHitTesting(false)
        }
    }
}
#endif
