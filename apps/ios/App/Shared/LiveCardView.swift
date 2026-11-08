import AppIntents
import NekkoProtocol
import SwiftUI

/// One scoped dashboard, app-wide voice first, app navigation second. The same
/// view renders the Lock Screen, expanded Island and inert Settings preview.
struct LiveCardView: View {
    let state: LiveCardState
    let level: LiveLevel
    let interactive: Bool
    var computerId = ""
    var computerName = ""
    var stale = false

    /// The card is always dark, whatever the phone's appearance: the Nekko plum
    /// ground, the app icon's tile and the launch screen's colour.
    static let background = Color(red: 0x19/255, green: 0, blue: 0x19/255)
    /// The app's coloured ground (`AppBackdrop` in dark): the accent washed in
    /// from the top. Drawn over `background` on the Lock Screen and in the
    /// Settings preview; the Dynamic Island stays black.
    static var wash: LinearGradient {
        LinearGradient(colors: [accent.opacity(0.16), accent.opacity(0.04)], startPoint: .top, endPoint: .bottom)
    }
    // Dark Nekko (`Palette.make(dark: true)` in Theme.swift): the extension runs
    // apart from the app and can't see its theme, so the card keeps the default.
    fileprivate static let accent = Color(red: 0xC0/255, green: 0x84/255, blue: 0xB5/255)
    private static let onAccent = Color(red: 0x0C/255, green: 0x0C/255, blue: 0x11/255)
    private static let grey = Color(red: 0xA3/255, green: 0xA1/255, blue: 0xB0/255)
    /// A secondary button: the plum of the app's own message bubbles.
    private static let raised = Color(red: 0x3A/255, green: 0x14/255, blue: 0x38/255)
    private static let attention = Color(red: 0xED/255, green: 0xBE/255, blue: 0x79/255)
    static let chatsURL = URL(string: "nekko-agent://chats")!
    static let showsMic = true

    // Kept for existing composer deep links; the dashboard never uses this route.
    static func listenURL(_ sessionId: String) -> URL {
        var c = URLComponents()
        c.scheme = "nekko-agent"
        c.host = "chat"
        c.path = "/" + sessionId
        c.queryItems = [URLQueryItem(name: "listen", value: "1")]
        return c.url!
    }

    /// "Always allow this tool" (an MCP tool only): open the chat, which saves the
    /// tool for that chat and then allows the call, as its own card does. It
    /// opens the app because the save is signed with Face ID or the passcode,
    /// which a Lock Screen button can't do in the background.
    static func alwaysAllowURL(_ sessionId: String, callId: String) -> URL {
        var c = URLComponents()
        c.scheme = "nekko-agent"
        c.host = "chat"
        c.path = "/" + sessionId
        c.queryItems = [URLQueryItem(name: "alwaysAllow", value: callId)]
        return c.url!
    }

    static func count(_ status: LiveChatState, in state: LiveCardState) -> Int {
        if let counts = state.counts { return max(0, counts[status.rawValue] ?? 0) }
        return state.chats.filter { $0.state == status }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                PixelCat().frame(width: 16, height: 16)
                Text("Nekko Agent").fontWeight(.semibold)
                Spacer(minLength: 4)
                Text(verbatim: computerName).foregroundStyle(Self.grey).privacySensitive()
            }
            .font(.system(size: 11)).lineLimit(1)
            if state.listening {
                HStack(spacing: 8) {
                    MicGlyph().stroke(Self.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                        .frame(width: 17, height: 17)
                    Text(state.heard.isEmpty ? "Listening…" : state.heard)
                        .font(.system(size: 13, weight: .medium)).lineLimit(2)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                if state.heard == "Processing…" {
                    HStack(spacing: 8) {
                        button(CancelTalkIntent()) { action(Text("Cancel"), primary: false) }
                        appLink { action(Text("Open app"), primary: false) }
                    }
                } else if state.heard == "Sending…" {
                    appLink { action(Text("Open app"), primary: false) }
                } else {
                    HStack(spacing: 8) {
                        button(CancelTalkIntent()) { action(Text("Cancel"), primary: false) }
                        button(FinishTalkIntent()) { action(Text("Finish speaking"), primary: true) }
                    }
                }
            } else {
                if state.heard.isEmpty {
                    HStack(spacing: 0) {
                        metric(.working, label: "Building")
                        metric(.needsYou, label: "Need input")
                        metric(.done, label: "Done")
                    }
                    .frame(height: 44)
                    detail
                } else {
                    // Dispatcher replies contain no transcript or chat titles, including at Minimal.
                    Text(verbatim: state.heard)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(3).minimumScaleFactor(0.85)
                        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                }
                HStack(spacing: 8) {
                    if #available(iOS 18, *) {
                        button(TalkToNekkoIntent(computerId: computerId)) {
                            HStack(spacing: 6) {
                                MicGlyph().stroke(Self.onAccent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                                    .frame(width: 15, height: 15)
                                Text("Talk to Nekko")
                            }
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Self.onAccent)
                            .frame(maxWidth: .infinity).frame(height: 44)
                            .background(Self.accent, in: RoundedRectangle(cornerRadius: 12))
                        }
                    } else {
                        appLink { action(Text("Open app for voice"), primary: true) }
                    }
                    appLink {
                        Text("Open app")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4).frame(minHeight: 44)
                    }
                }
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    private func metric(_ status: LiveChatState, label: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.count(status, in: state), format: .number)
                .font(.system(size: 27, weight: .semibold)).monospacedDigit()
            Text(label).font(.system(size: 11))
        }
        .foregroundStyle(status == .needsYou ? Self.attention : .white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var detail: some View {
        HStack(spacing: 8) {
            if stale {
                Text("Status may be out of date")
            } else if state.counts == nil, state.more > 0 {
                Text("Partial counts · open app")
            } else {
                let watching = Self.count(.watching, in: state)
                let failed = Self.count(.failed, in: state)
                if watching > 0 { Text("\(watching) watching") }
                if failed > 0 { Text("\(failed) failed").foregroundStyle(Self.attention) }
                if watching == 0 && failed == 0 { Text("Done in the last 2 hours") }
            }
        }
        .font(.system(size: 10)).foregroundStyle(Self.grey)
        .lineLimit(1).minimumScaleFactor(0.8)
    }

    private func action(_ label: Text, primary: Bool) -> some View {
        label.font(.system(size: 12, weight: .semibold)).lineLimit(1)
            .foregroundStyle(primary ? Self.onAccent : .white)
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(primary ? Self.accent : Self.raised, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func appLink(@ViewBuilder label: () -> some View) -> some View {
        if interactive { Link(destination: Self.chatsURL, label: label) }
        else { label() }
    }

    @ViewBuilder
    private func button(_ intent: some AppIntent, @ViewBuilder label: () -> some View) -> some View {
        if interactive { Button(intent: intent, label: label).buttonStyle(.plain) }
        else { label() }
    }
}
