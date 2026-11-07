import NekkoKit
import NekkoProtocol
import SwiftUI

/// A real-width popover instead of the system Picker's narrow, wrapping menu.
/// Choosing YOLO from another mode shows the YOLO warning first (decision 0054),
/// so every place that uses it (Simple's chat picker, New chat) warns.
struct ToolPolicyPicker: View {
    @Binding var selection: PcSettings.ChatMode
    @Environment(\.palette) private var palette
    @Environment(Prefs.self) private var prefs
    @State private var open = false
    /// YOLO was picked and needs the warning, shown once the popover has gone.
    @State private var wantsYolo = false
    @State private var yoloAsk: YoloAsk?

    static func icon(_ mode: PcSettings.ChatMode) -> String {
        switch mode {
        case .ask: "hand.raised"
        case .guardrails: "shield.lefthalf.filled"
        case .yolo: "bolt"
        }
    }

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 4) {
                Image(systemName: Self.icon(selection)).foregroundStyle(palette.inkSoft)
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
                        if YoloWarning.needed(from: selection, to: mode, skipped: prefs.skipYoloWarning) {
                            wantsYolo = true
                        } else {
                            selection = mode
                        }
                        open = false
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: Self.icon(mode)).frame(width: 22).foregroundStyle(palette.accent)
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
            // One presentation at a time: the warning waits for the popover to close.
            .onDisappear {
                guard wantsYolo else { return }
                wantsYolo = false
                yoloAsk = YoloAsk { selection = .yolo }
            }
        }
        .yoloWarning($yoloAsk)
    }
}
