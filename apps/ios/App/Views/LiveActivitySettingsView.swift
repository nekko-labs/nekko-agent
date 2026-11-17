import NekkoProtocol
import SwiftUI

/// Settings → Live Activities: how much the card shows, under the real card
/// (`LiveCardView`, the widget's own view) built the way a push builds it at the
/// chosen level (`buildCard`), so the preview cannot drift from what is sent.
/// The card draws counts at every level (decision 0070); Standard and Detailed
/// differ in what rides along in the state, which the lines under the preview list.
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
                if !sent.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(sent, id: \.id) { chat in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: [chat.title, chat.step].filter { !$0.isEmpty }.joined(separator: " · "))
                                if !chat.reply.isEmpty {
                                    Text(verbatim: chat.reply).foregroundStyle(palette.inkSoft)
                                }
                            }
                        }
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: prefs.liveActivityLevel)
            Section {
                Picker("Live Activities", selection: $prefs.liveActivityLevel) {
                    ForEach(LiveLevel.allCases, id: \.self) { Text($0.label).tag($0) }
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

    /// The chats as the push carries them at this level, with text (none at Minimal).
    private var sent: [LiveChat] {
        guard let card = LiveCardState.sampleCard(level: prefs.liveActivityLevel) else { return [] }
        return card.chats.filter { !$0.title.isEmpty || !$0.step.isEmpty || !$0.reply.isEmpty }.prefix(2).map { $0 }
    }

    private var footer: LocalizedStringKey? {
        switch prefs.liveActivityLevel {
        case .none:
            return "No card on the Lock Screen or in the Dynamic Island."
        case .minimal:
            return "Agent counts only. No chat text is sent. Talk to Nekko asks you to unlock first. Say status, or send to a named chat and confirm the exact message. iOS 17 opens the app for voice."
        case .standard:
            return "The same counts. The relay and Apple’s push service also carry each chat’s name and current step, listed under the preview; the card does not draw them. Choose Minimal to send none."
        case .detailed:
            return "The same counts. The relay and Apple’s push service also carry each chat’s name, current step and latest reply, listed under the preview; the card does not draw them. Choose Minimal to send none."
        }
    }
}

extension LiveLevel {
    var label: String {
        switch self {
        case .none: return String(localized: "None")
        case .minimal: return String(localized: "Minimal")
        case .standard: return String(localized: "Standard")
        case .detailed: return String(localized: "Detailed")
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
            if let card = LiveCardState.sampleCard(level: level) {
                LiveCardView(state: card, level: level, interactive: false, computerName: "Mac")
                    .padding(14)
                    .background(LiveCardView.wash, in: RoundedRectangle(cornerRadius: 22))
                    .background(LiveCardView.background.opacity(0.92), in: RoundedRectangle(cornerRadius: 22))
                    .transition(.opacity)
            } else {
                Text("Nothing on the Lock Screen")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
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
    /// The Settings preview and the debug sample: one chat waiting on an approval and one working as
    /// rows, two more counted under them.
    static let sample = sampleCard(level: .detailed)!

    /// The sample as a push builds it at `level` (nil at None), so Minimal has no
    /// chat text and Standard has no reply lines.
    static func sampleCard(level: LiveLevel) -> LiveCardState? {
        buildCard(chats: sampleChats, previous: nil, pinnedFocus: nil, level: level, now: Date())
    }

    private static var sampleChats: [LiveChat] { [
        LiveChat(id: "billing", short: "Billing", state: .needsYou, step: "Run npm test", reply: "Want me to run the tests first?",
                 closeWord: "Nice", finishedAt: nil, callId: "sample", severity: "low", startedAt: Date().addingTimeInterval(-754),
                 title: "Billing page redesign"),
        LiveChat(id: "login", short: "Login", state: .working, step: "Fixing merge conflicts", reply: "Got it. Working on it now.",
                 closeWord: "Cool", finishedAt: nil, callId: nil, severity: nil, startedAt: Date().addingTimeInterval(-312),
                 title: "Fix the login redirect"),
        LiveChat(id: "ios", short: "iOS LA", state: .watching, step: "Watching PR #1211…", reply: "PR is up.",
                 closeWord: "Perfect", finishedAt: nil, callId: nil, severity: nil),
        LiveChat(id: "docs", short: "Docs", state: .done, step: "Finished", reply: "Docs page added.",
                 closeWord: "Looks good", finishedAt: Date(), callId: nil, severity: nil),
    ] }
}
