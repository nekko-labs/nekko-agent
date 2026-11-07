import AppIntents
import NekkoProtocol
import SwiftUI

/// The one Live Activity card for all chats, on the Lock Screen and in the
/// expanded Dynamic Island, and (with `interactive == false`) the preview in
/// Settings. Two chats as rows with their titles (what needs you first, see
/// `cardRows`), a line counting the rest by state ("3 Working · 5 Done"), and
/// the buttons for the focused row. Apple caps the card at about 160 pt, so
/// listening swaps the rows for the focused one and the dictation area.
struct LiveCardView: View {
    let state: LiveCardState
    let level: LiveLevel
    let interactive: Bool

    /// The card is always dark, whatever the phone's appearance.
    static let background = Color(red: 28/255, green: 28/255, blue: 30/255)
    // The default dark palette (Theme.swift): the extension runs apart from the app and can't see its theme.
    fileprivate static let accent = Color(red: 0x8B/255, green: 0x7D/255, blue: 0xFF/255)
    fileprivate static let onAccent = Color(red: 0x0C/255, green: 0x0C/255, blue: 0x11/255)
    fileprivate static let danger = Color(red: 0xEF/255, green: 0x6A/255, blue: 0x5B/255)
    fileprivate static let grey = Color(red: 0xA3/255, green: 0xA1/255, blue: 0xB0/255)
    fileprivate static let surface = grey.opacity(0.14)
    fileprivate static let raised = grey.opacity(0.24)
    /// Where the count line goes: the app's chat list.
    static let chatsURL = URL(string: "nekko-agent://chats")!
    /// The Detailed mic, on the card and in the Settings preview.
    static let showsMic = true

    /// The mic on iOS 17, which has no `AudioRecordingIntent`: open the chat listening.
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

    private var focus: LiveChat? { state.chats.first { $0.id == state.focusId } ?? state.chats.first }
    private var showsText: Bool { level == .standard || level == .detailed }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.listening {
                if let focus { row(focus, focused: true) }
                dictation
            } else {
                let rows = cardRows(state)
                VStack(spacing: 3) {
                    ForEach(rows, id: \.id) { row($0, focused: rows.count > 1 && $0.id == focus?.id) }
                }
                tallyLine
                if let focus { actions(focus) }
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    // MARK: Rows

    /// A chat's row: its status, its title (Standard up; Minimal shows only the
    /// generic phase line), what it is doing, and how long it has run. Tapping
    /// it brings it into focus, which moves the buttons to it.
    private func row(_ chat: LiveChat, focused: Bool) -> some View {
        let title = showsText ? (chat.title.isEmpty ? chat.short : chat.title) : ""
        return button(FocusChatIntent(sessionId: chat.id)) {
            HStack(spacing: 8) {
                LiveStatusGlyph(state: chat.state, size: 11, ink: .black)
                    .frame(width: 22, height: 22)
                    .background(chat.state.tint, in: Circle())
                VStack(alignment: .leading, spacing: 0) {
                    Text(title.isEmpty ? chat.state.phaseLine : title)
                        .font(.system(size: 13, weight: .semibold))
                        .privacySensitive(!title.isEmpty)
                    if let detail = detail(chat, titled: !title.isEmpty) {
                        Text(detail).font(.system(size: 11)).foregroundStyle(Self.grey).privacySensitive()
                    }
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                if chat.state == .working || chat.state == .needsYou, let start = chat.startedAt { elapsed(since: start) }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(focused ? Self.raised : Self.surface, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(focused ? .isSelected : [])
        .accessibilityValue(Text(chat.state.label))
    }

    /// The row's second line: the live step (Standard up); at Detailed the reply
    /// line once the chat stops ("Finished" says less) and what the mic sent for
    /// the focused chat. Under a title with no step, the phase line, so every
    /// titled row says what it is doing. Nil at Minimal, where the phase line
    /// is the whole row.
    private func detail(_ chat: LiveChat, titled: Bool) -> String? {
        guard showsText else { return nil }
        let running = chat.state == .working || chat.state == .needsYou
        if level == .detailed, chat.id == focus?.id, !state.heard.isEmpty, !state.listening { return state.heard }
        if level == .detailed, !running, !chat.reply.isEmpty { return chat.reply }
        if !chat.step.isEmpty { return chat.step }
        return titled ? chat.state.phaseLine : nil
    }

    // MARK: Count line

    /// The chats that are not rows, by state ("3 Working · 5 Done"), plus the
    /// chats past the eight the card carries ("+2"). It opens the app's chat
    /// list. At Detailed the mic sits at its end.
    @ViewBuilder
    private var tallyLine: some View {
        let tally = cardTally(state)
        let mic = Self.showsMic && level == .detailed
        if !tally.isEmpty || (mic && focus != nil) {
            HStack(spacing: 6) {
                tallyWords(tally).frame(maxWidth: .infinity, alignment: .leading)
                if mic, let focus { micButton(focus) }
            }
        }
    }

    @ViewBuilder
    private func tallyWords(_ tally: CardTally) -> some View {
        let words = HStack(spacing: 10) {
            ForEach(tally.states, id: \.self) { item in
                HStack(spacing: 4) {
                    LiveStatusGlyph(state: item.state, size: 10)
                    Text(verbatim: "\(item.count) \(item.state.label)")
                }
            }
            if tally.more > 0 { Text(verbatim: "+\(tally.more)") }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Self.grey)
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: tally.states.map { "\($0.count) \($0.state.label)" }.joined(separator: ", ")))
        .accessibilityValue(tally.more > 0 ? Text("\(tally.more) more chats") : Text(verbatim: ""))
        if interactive, !tally.isEmpty {
            Link(destination: Self.chatsURL) { words }
        } else {
            words
        }
    }

    private func micButton(_ focus: LiveChat) -> some View {
        Group {
            if #available(iOS 18, *) {
                button(TalkToChatIntent(sessionId: focus.id)) { mic }
            } else if interactive {
                Link(destination: Self.listenURL(focus.id)) { mic }
            } else {
                mic
            }
        }
        .accessibilityLabel(Text("Talk to this chat"))
    }

    private var mic: some View {
        MicGlyph().stroke(Self.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .frame(width: 12, height: 12)
            .frame(width: 20, height: 20)
            .background(Self.surface, in: Circle())
    }

    // MARK: Dictation and close

    private var dictation: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                LevelBars()
                Text(state.heard.isEmpty ? String(localized: "Listening…") : state.heard)
                    .font(.system(size: 13)).lineLimit(1).privacySensitive()
            }
            HStack(spacing: 8) {
                button(CancelTalkIntent()) { pill(Text("Cancel"), fill: Self.surface) }
                if let focus {
                    let to = showsText ? focus.short : ""
                    button(TalkToChatIntent(sessionId: focus.id)) {
                        pill(to.isEmpty ? Text("Send") : Text("Send to \(to)"), fill: Self.accent, ink: Self.onAccent)
                            .privacySensitive(!to.isEmpty)
                    }
                }
            }
        }
    }

    private func elapsed(since start: Date) -> some View {
        HStack(spacing: 3) {
            ClockGlyph().stroke(Self.grey, style: StrokeStyle(lineWidth: 1.3, lineCap: .round)).frame(width: 11, height: 11)
            Text(timerInterval: start...Date.distantFuture, countsDown: false)
                .monospacedDigit()
                .frame(maxWidth: 56, alignment: .leading)
        }
        .font(.system(size: 12))
        .foregroundStyle(Self.grey)
        .fixedSize()
    }

    /// Under the count line, for the focused chat: Deny (and Allow from Standard
    /// up, plus Always for an MCP tool) while a tool waits, Stop while it works,
    /// the close button once finished. Allow asks for Face ID or the passcode
    /// (`AllowToolIntent`); Always opens the chat (`alwaysAllowURL`).
    @ViewBuilder
    private func actions(_ chat: LiveChat) -> some View {
        switch chat.state {
        case .needsYou:
            if let callId = chat.callId {
                HStack(spacing: 8) {
                    button(AnswerApprovalIntent(sessionId: chat.id, callId: callId, allow: false)) {
                        pill(Text("Deny"), fill: Self.raised, ink: Self.danger)
                    }
                    if showsText {
                        button(AllowToolIntent(sessionId: chat.id, callId: callId)) {
                            pill(Text("Allow"), fill: Self.accent, ink: Self.onAccent)
                        }
                        if chat.alwaysAllow {
                            link(Self.alwaysAllowURL(chat.id, callId: callId)) {
                                pill(Text("Always allow"), fill: Self.raised, ink: Self.accent)
                            }
                            .accessibilityHint(Text("Opens the chat to allow this call and stop asking for this tool in it"))
                        }
                    }
                }
            }
        case .working:
            button(StopRunIntent(sessionId: chat.id)) {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.white).frame(width: 9, height: 9)
                    Text("Stop")
                }
                .font(.system(size: 12, weight: .medium))
                .frame(maxWidth: .infinity).frame(height: 28)
                .background(Self.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        case .done, .failed:
            close(chat)
        case .watching:
            EmptyView()
        }
    }

    private func close(_ chat: LiveChat) -> some View {
        let failed = chat.state == .failed
        let word = chat.closeWord.isEmpty ? closeWord(for: chat.id, failed: failed) : chat.closeWord
        let ink = failed ? Color.white : Self.onAccent
        return button(DismissChatIntent(sessionId: chat.id)) {
            HStack(spacing: 6) {
                CheckGlyph().stroke(ink, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)).frame(width: 12, height: 12)
                // The words in the state are English; the catalog has them (a push may send others).
                Text(LocalizedStringKey(word))
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .background(failed ? Self.raised : Self.accent, in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityHint(Text("Removes this chat from the card"))
    }

    private func pill(_ label: Text, fill: Color, ink: Color = .white) -> some View {
        label.font(.system(size: 12, weight: .medium)).lineLimit(1)
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity).frame(height: 28)
            .background(fill, in: RoundedRectangle(cornerRadius: 10))
    }

    /// A link that opens the app; the Settings preview draws the same thing inert.
    @ViewBuilder
    private func link(_ url: URL, @ViewBuilder label: () -> some View) -> some View {
        if interactive { Link(destination: url, label: label) } else { label() }
    }

    /// A real intent button on the card; the Settings preview draws the same thing inert.
    @ViewBuilder
    private func button(_ intent: some AppIntent, @ViewBuilder label: () -> some View) -> some View {
        if interactive {
            Button(intent: intent, label: label).buttonStyle(.plain)
        } else {
            Button(action: {}, label: label).buttonStyle(.plain)
        }
    }
}

/// A still level meter: a Live Activity cannot animate on its own.
private struct LevelBars: View {
    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array([6, 12, 16, 9, 14, 7, 11, 15, 8, 5].enumerated()), id: \.offset) { _, h in
                Capsule().fill(LiveCardView.accent).frame(width: 3, height: CGFloat(h))
            }
        }
        .frame(height: 18)
        .accessibilityHidden(true)
    }
}
