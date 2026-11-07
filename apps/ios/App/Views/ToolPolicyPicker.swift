import NekkoProtocol
import SwiftUI

/// A real-width popover instead of the system Picker's narrow, wrapping menu.
struct ToolPolicyPicker: View {
    @Binding var selection: PcSettings.ChatMode
    @Environment(\.palette) private var palette
    @State private var open = false

    static func icon(_ mode: PcSettings.ChatMode) -> String {
        switch mode {
        case .ask: "permission-hand"
        case .guardrails: "permission-shield-check"
        case .yolo: "permission-running"
        }
    }

    /// Gentleface 0.3.0 line icons, MIT. See App/PermissionIcons-LICENSE.txt.
    static func image(_ mode: PcSettings.ChatMode) -> some View {
        Image(icon(mode)).renderingMode(.template).resizable().scaledToFit()
            .frame(width: 16, height: 16).accessibilityHidden(true)
    }

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 4) {
                Self.image(selection).foregroundStyle(palette.inkSoft)
                Text(SimpleMode.asksName(selection)).lineLimit(1).truncationMode(.tail)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .font(.footnote).foregroundStyle(palette.ink)
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("When the agent asks you")
        .accessibilityValue(SimpleMode.asksName(selection))
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(PcSettings.ChatMode.allCases, id: \.self) { mode in
                    Button {
                        selection = mode
                        open = false
                    } label: {
                        HStack(spacing: 10) {
                            Self.image(mode).frame(width: 22).foregroundStyle(palette.accent)
                            Text(SimpleMode.asksName(mode)).lineLimit(1).minimumScaleFactor(0.75)
                            Spacer(minLength: 4)
                            Image(systemName: "checkmark").opacity(selection == mode ? 1 : 0)
                                .foregroundStyle(palette.accent)
                        }
                        .foregroundStyle(palette.ink)
                        .padding(.horizontal, 12).frame(minHeight: 48)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selection == mode ? .isSelected : [])
                    .accessibilityIdentifier("tools.\(mode.rawValue)")
                }
            }
            .padding(8).frame(width: 300)
            .presentationCompactAdaptation(.popover)
        }
    }
}
