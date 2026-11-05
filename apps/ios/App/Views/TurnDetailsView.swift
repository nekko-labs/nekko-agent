import NekkoProtocol
import SwiftUI

/// The persisted reply's closing line. One wrapping text keeps every metric
/// readable at phone widths and Dynamic Type sizes, without a horizontal scroller.
struct TurnDetailsView: View {
    let details: TurnDetails
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if details.successful {
                Label("Done", systemImage: "checkmark")
                    .foregroundStyle(palette.success)
            }
            Text(details.parts.joined(separator: " · "))
                .foregroundStyle(palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
                #if DEBUG
                .modifier(TurnDetailsProbeSelection())
                .modifier(TurnDetailsMeasureText())
                .modifier(TurnDetailsMeasureFrame(name: "metrics"))
                #else
                .textSelection(.enabled)
                #endif
        }
        .font(.caption2.monospacedDigit())
        .frame(maxWidth: .infinity, alignment: .leading)
        #if DEBUG
        .modifier(TurnDetailsMeasureFrame(name: "footer"))
        #endif
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((details.successful ? "Done. " : "") + details.parts.joined(separator: ", "))
        .accessibilityIdentifier("turn.details.\(details.id)")
    }
}
