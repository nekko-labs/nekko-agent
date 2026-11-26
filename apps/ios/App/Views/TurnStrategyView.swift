import NekkoProtocol
import SwiftUI

/// A change in admitted modes, not an activity indicator.
struct TurnStrategyView: View {
    let strategy: TurnStrategy
    @Environment(\.palette) private var palette

    private var tools: String {
        switch strategy.tools {
        case .code: String(localized: "Code mode")
        case .list: String(localized: "Tool list")
        case .none: String(localized: "No tools")
        case .claudeCode: String(localized: "Claude Code")
        }
    }

    private var summary: String {
        switch strategy.orchestration {
        case .direct: "\(tools) · \(String(localized: "Direct"))"
        case .coordinator: "\(tools) · \(String(localized: "Orchestration"))"
        case .worker: "\(tools) · \(String(localized: "Worker"))"
        case .external: String(localized: "Claude Code manages its own tools.")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Strategy")
                .font(.caption.weight(.medium))
                .foregroundStyle(palette.inkSoft)
            Text(summary)
                .font(.caption)
                .foregroundStyle(palette.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Strategy") + Text(verbatim: ": \(summary)"))
        .accessibilityIdentifier("turn-strategy")
    }
}
