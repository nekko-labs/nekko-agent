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
    fileprivate static let surface = Color(white: 0.17)
    fileprivate static let raised = Color(white: 0.28)
    fileprivate static let grey = Color(white: 0.68)
    fileprivate static let orange = Color(red: 1, green: 0.62, blue: 0.04)

    private var focus: LiveChat? { state.chats.first { $0.id == state.focusId } ?? state.chats.first }
    private var showsText: Bool { level == .standard || level == .detailed }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                LiveMascot(state: focus?.state ?? .working)
                top
            }
            if state.listening {
                dictation
            } else {
                strip
                if let focus, focus.state == .done || focus.state == .failed { close(focus) }
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
                if level == .detailed, !focus.reply.isEmpty {
                    Text(focus.reply).font(.system(size: 12)).foregroundStyle(Color(white: 0.82)).privacySensitive()
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
            if level == .detailed, let focus {
                button(TalkToChatIntent(sessionId: focus.id)) {
                    MicGlyph().stroke(Self.orange, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                        .frame(width: 16, height: 16)
                        .frame(width: 30, height: 30)
                        .background(Self.surface, in: Circle())
                }
                .accessibilityLabel(Text("Talk to this chat"))
            }
        }
    }

    /// The page of `size` chips that holds the focused chat, so it is always
    /// shown, and the chat "+N" focuses: the next page's first (or the first again).
    static func page(_ chats: [LiveChat], focus: String?, size: Int) -> (shown: ArraySlice<LiveChat>, next: LiveChat?) {
        let start = ((chats.firstIndex { $0.id == focus } ?? 0) / size) * size
        let shown = chats[start..<min(start + size, chats.count)]
        return (shown, shown.endIndex < chats.count ? chats[shown.endIndex] : chats.first)
    }

    private func chips(_ count: Int) -> some View {
        let (shown, next) = Self.page(state.chats, focus: focus?.id, size: count)
        let hidden = state.chats.count - shown.count + state.more
        return HStack(spacing: 6) {
            ForEach(shown, id: \.id) { chip($0) }
            if hidden > 0, let next {
                button(NextPageIntent(sessionId: next.id)) {
                    chipLabel(on: false) { Text("+\(hidden)") }
                }
                .accessibilityLabel(Text("\(hidden) more chats"))
            }
        }
        .fixedSize()
    }

    private func chip(_ chat: LiveChat) -> some View {
        button(FocusChatIntent(sessionId: chat.id)) {
            chipLabel(on: chat.id == focus?.id) {
                LiveStatusGlyph(state: chat.state, size: 12)
                if showsText, !chat.short.isEmpty { Text(chat.short).privacySensitive() }
            }
        }
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
                        pill(to.isEmpty ? Text("Send") : Text("Send to \(to)"), fill: Color(red: 0.04, green: 0.52, blue: 1))
                            .privacySensitive(!to.isEmpty)
                    }
                }
            }
        }
    }

    private func close(_ chat: LiveChat) -> some View {
        let failed = chat.state == .failed
        let word = chat.closeWord.isEmpty ? closeWord(for: chat.id, failed: failed) : chat.closeWord
        let ink = failed ? Color.white : Color(red: 0.02, green: 0.13, blue: 0.05)
        return button(DismissChatIntent(sessionId: chat.id)) {
            HStack(spacing: 6) {
                CheckGlyph().stroke(ink, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)).frame(width: 12, height: 12)
                Text(word)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ink)
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .background(failed ? Self.raised : LiveChatState.done.tint, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func pill(_ label: Text, fill: Color) -> some View {
        label.font(.system(size: 12, weight: .medium)).lineLimit(1)
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
                Capsule().fill(LiveCardView.orange).frame(width: 3, height: CGFloat(h))
            }
        }
        .frame(height: 18)
        .accessibilityHidden(true)
    }
}
