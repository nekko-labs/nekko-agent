import NekkoProtocol
import SwiftUI

/// Settings → Live Activities: how much the card shows, under the real card
/// (`LiveCardView`, the widget's own view) drawn at the chosen level.
struct LiveActivitySettingsView: View {
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            Section {
                LockScreenPreview(level: prefs.liveActivityLevel)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section {
                Picker("Live Activities", selection: $prefs.liveActivityLevel) {
                    ForEach(LiveLevel.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityIdentifier("liveActivities.level")
            } footer: {
                if let footer {
                    Text(footer).foregroundStyle(palette.inkSoft)
                }
            }
        }
        .appBackground()
        .navigationTitle("Live Activities")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var footer: String? {
        switch prefs.liveActivityLevel {
        case .none: return nil
        case .minimal: return "No chat text leaves your computer for the Lock Screen."
        case .standard, .detailed:
            return "Chat titles and status are shown when your phone is unlocked. While the app is closed they reach your phone through the relay and Apple’s push service."
        }
    }
}

/// A dark Lock Screen with the card on it (none at None).
private struct LockScreenPreview: View {
    let level: LiveLevel

    var body: some View {
        VStack(spacing: 14) {
            Text("9:41")
                .font(.system(size: 54, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.9))
                .accessibilityHidden(true)
            if level != .none {
                LiveCardView(state: .sample, level: level, interactive: false)
                    .padding(14)
                    .background(LiveCardView.background.opacity(0.92), in: RoundedRectangle(cornerRadius: 22))
                    .transition(.opacity)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 300, alignment: .top)
        .background(LinearGradient(colors: [Color(red: 0.10, green: 0.12, blue: 0.22), Color(red: 0.03, green: 0.03, blue: 0.06)],
                                   startPoint: .top, endPoint: .bottom),
                    in: RoundedRectangle(cornerRadius: 28))
        .animation(.easeInOut(duration: 0.2), value: level)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Preview of the Lock Screen")
    }
}

extension LiveCardState {
    /// The Settings preview: one chat waiting on an approval, three more on the strip.
    static let sample = LiveCardState(chats: [
        LiveChat(id: "billing", short: "Billing", state: .needsYou, step: "Run npm test", reply: "Want me to run the tests first?",
                 closeWord: "Nice", finishedAt: nil, callId: "sample", severity: "low", startedAt: Date().addingTimeInterval(-754)),
        LiveChat(id: "login", short: "Login", state: .working, step: "Fixing merge conflicts", reply: "Got it. Working on it now.",
                 closeWord: "Cool", finishedAt: nil, callId: nil, severity: nil),
        LiveChat(id: "ios", short: "iOS LA", state: .watching, step: "Watching PR #1211…", reply: "PR is up.",
                 closeWord: "Perfect", finishedAt: nil, callId: nil, severity: nil),
        LiveChat(id: "docs", short: "Docs", state: .done, step: "Finished", reply: "Docs page added.",
                 closeWord: "Looks good", finishedAt: Date(), callId: nil, severity: nil),
    ], focusId: "billing", more: 0, listening: false, heard: "")
}
