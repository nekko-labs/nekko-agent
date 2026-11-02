import AppIntents
import NekkoProtocol
import SwiftUI

/// The one Live Activity card for all chats, on the Lock Screen and in the
/// expanded Dynamic Island, and (with `interactive == false`) the preview in
/// Settings. Apple caps the card at about 160 pt, so listening swaps the chip
/// strip for the dictation area instead of adding to it.
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
    /// Where "+N" goes when every chat on the card is already a chip: the app.
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

    private var focus: LiveChat? { state.chats.first { $0.id == state.focusId } ?? state.chats.first }
    private var showsText: Bool { level == .standard || level == .detailed }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                LiveMascot(state: focus?.state ?? .working)
                top
                if let focus, focus.state == .working || focus.state == .needsYou, let start = focus.startedAt { elapsed(since: start) }
            }
            if state.listening {
                dictation
            } else {
                strip
                if let focus { actions(focus) }
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    // MARK: Focused chat

    private var top: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let focus {
                let title = showsText ? focus.short : ""
                if !title.isEmpty {
                    Text(title).font(.system(size: 14, weight: .semibold)).privacySensitive()
                }
                Text(showsText && !focus.step.isEmpty ? focus.step : focus.state.phaseLine)
                    .font(title.isEmpty ? .system(size: 14, weight: .semibold) : .system(size: 13))
                    .foregroundStyle(title.isEmpty ? Color.white : Self.grey)
                    .privacySensitive(showsText)
                // What the mic sent ("Sent: ..."), until the reply line takes its place.
                let line = state.heard.isEmpty || state.listening ? focus.reply : state.heard
                if level == .detailed, !line.isEmpty {
                    Text(line).font(.system(size: 12)).foregroundStyle(Color(white: 0.82)).privacySensitive()
                }
            }
        }
        .lineLimit(1)
        .contentTransition(.opacity)
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(focus?.id)
        .transition(.push(from: .bottom))
    }

    // MARK: Chip strip

    private var strip: some View {
        HStack(spacing: 6) {
            // As many chips as fit; the rest are counted in the "+N" chip.
            ViewThatFits(in: .horizontal) {
                ForEach(Array((1...max(state.chats.count, 1)).reversed()), id: \.self) { chips($0) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if Self.showsMic, level == .detailed, let focus {
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
        }
    }

    private var mic: some View {
        MicGlyph().stroke(Self.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .frame(width: 16, height: 16)
            .frame(width: 30, height: 30)
            .background(Self.surface, in: Circle())
    }

    /// The page of `size` chips that holds the focused chat, so it is always
    /// shown, and the chat "+N" focuses: the next page's first (or the first
    /// again). Nil when every chat is shown, so "+N" only counts chats past the eight.
    static func page(_ chats: [LiveChat], focus: String?, size: Int) -> (shown: ArraySlice<LiveChat>, next: LiveChat?) {
        let start = ((chats.firstIndex { $0.id == focus } ?? 0) / size) * size
        let shown = chats[start..<min(start + size, chats.count)]
        if shown.count == chats.count { return (shown, nil) }
        return (shown, shown.endIndex < chats.count ? chats[shown.endIndex] : chats.first)
    }

    private func chips(_ count: Int) -> some View {
        let (shown, next) = Self.page(state.chats, focus: focus?.id, size: count)
        let hidden = state.chats.count - shown.count + state.more
        return HStack(spacing: 6) {
            ForEach(shown, id: \.id) { chip($0) }
            if hidden > 0 {
                Group {
                    if let next {
                        button(NextPageIntent(sessionId: next.id)) { chipLabel(on: false) { Text("+\(hidden)") } }
                    } else if interactive {
                        Link(destination: Self.chatsURL) { chipLabel(on: false) { Text("+\(hidden)") } }
                    } else {
                        chipLabel(on: false) { Text("+\(hidden)") }
                    }
                }
                .accessibilityLabel(Text("\(hidden) more chats"))
            }
        }
        .fixedSize()
    }

    private func chip(_ chat: LiveChat) -> some View {
        let on = chat.id == focus?.id
        let position = (state.chats.firstIndex { $0.id == chat.id } ?? 0) + 1
        return button(FocusChatIntent(sessionId: chat.id)) {
            chipLabel(on: on) {
                LiveStatusGlyph(state: chat.state, size: 12)
                if showsText, !chat.short.isEmpty { Text(chat.short).privacySensitive() }
            }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
        // Minimal chips have no title: VoiceOver tells them apart by place.
        .modifier(PositionLabel(on: !showsText || chat.short.isEmpty, text: Text("Chat \(position) of \(state.chats.count + state.more)"),
                                value: Text(chat.state.label)))
    }

    private func chipLabel(on: Bool, @ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 4, content: content)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .foregroundStyle(on ? Color.white : Self.grey)
            .padding(.horizontal, 7)
            .frame(height: 24)
            .background(on ? Self.raised : Self.surface, in: RoundedRectangle(cornerRadius: 10))
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

    /// Under the strip, for the focused chat: Deny (and Allow from Standard up)
    /// while a tool waits, Stop while it works, the close button once finished.
    /// Allow asks for Face ID or the passcode (`AllowToolIntent`).
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

private struct PositionLabel: ViewModifier {
    let on: Bool
    let text: Text
    let value: Text

    func body(content: Content) -> some View {
        if on {
            // .ignore makes a new element, which drops the Button's trait; add it back.
            content.accessibilityElement(children: .ignore).accessibilityLabel(text).accessibilityValue(value).accessibilityAddTraits(.isButton)
        } else {
            content
        }
    }
}

/// The mascot on the card's left: the cat in a disc, the focused chat's status as a badge.
struct LiveMascot: View {
    let state: LiveChatState
    var size: CGFloat = 44

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            PixelCat(happy: state == .done)
                .padding(size * 0.18)
                .frame(width: size, height: size)
                .background(LiveCardView.surface, in: Circle())
            LiveStatusGlyph(state: state, size: size * 0.22, ink: .black)
                .frame(width: size * 0.38, height: size * 0.38)
                .background(state.tint, in: Circle())
                .overlay(Circle().stroke(LiveCardView.background, lineWidth: 2))
                .offset(x: 2, y: 2)
        }
        .accessibilityElement()
        .accessibilityLabel(state.label)
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
