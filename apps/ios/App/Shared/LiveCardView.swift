import AppIntents
import NekkoProtocol
import SwiftUI

/// The one Live Activity card for all chats, on the Lock Screen and in the
/// expanded Dynamic Island, and (with `interactive == false`) the preview in
/// Settings. Each chat is a chip (its status, title and elapsed time) in a
/// wrapping flow, what needs you first (see `cardChips`), and a "+N" chip for
/// the rest. A chip opens its chat in the app. Its actions sit on the chip
/// itself, so it is clear which chat they answer: Deny and Allow on a chat
/// waiting on a tool, the close check on a finished one, and at Detailed the
/// mic on the focused one. Under the chips, the focused chat's live step.
/// Apple caps the card at about 160 pt, so listening swaps the chips for the
/// focused one and the dictation area.
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
    /// Where the "+N" chip goes: the app's chat list.
    static let chatsURL = URL(string: "nekko-agent://chats")!
    /// The Detailed mic, on the card and in the Settings preview.
    static let showsMic = true
    /// A chip's height, and its buttons' (inside it).
    fileprivate static let chipHeight: CGFloat = 28
    fileprivate static let buttonSize: CGFloat = 22

    /// A chip: open that chat (`AppModel.handle(url:)`).
    static func chatURL(_ sessionId: String) -> URL {
        var c = URLComponents()
        c.scheme = "nekko-agent"
        c.host = "chat"
        c.path = "/" + sessionId
        return c.url!
    }

    /// The mic on iOS 17, which has no `AudioRecordingIntent`: open the chat listening.
    static func listenURL(_ sessionId: String) -> URL {
        var c = URLComponents(url: chatURL(sessionId), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "listen", value: "1")]
        return c.url!
    }

    private var focus: LiveChat? { state.chats.first { $0.id == state.focusId } ?? state.chats.first }
    private var showsText: Bool { level == .standard || level == .detailed }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.listening {
                if let focus { chip(focus, focused: true) }
                dictation
            } else {
                // Five chips when they fit in two lines, else fewer: the rest join "+N".
                ViewThatFits(in: .vertical) {
                    chips(limit: 5)
                    chips(limit: 4)
                    chips(limit: 3)
                    chips(limit: 2)
                    chips(limit: 1)
                }
                .frame(maxHeight: Self.chipsHeight, alignment: .top)
                if let focus, let detail = detail(focus) { detailLine(focus, detail) }
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    // MARK: Chips

    /// `LiveCardRules.chipLines` lines of chips, with the spacing between them.
    fileprivate static let chipsHeight = CGFloat(LiveCardRules.chipLines) * chipHeight + CGFloat(LiveCardRules.chipLines - 1) * 6

    private func chips(limit: Int) -> some View {
        let all = cardChips(state, limit: limit)
        return ChipFlow(spacing: 6) {
            ForEach(all.chips, id: \.id) { chip($0, focused: all.chips.count > 1 && $0.id == focus?.id) }
            if all.more > 0 { moreChip(all.more) }
        }
    }

    /// A chat's chip: its status, its title (Standard up; Minimal shows no chat
    /// text) and how long it has run, which opens the chat; then the chat's own
    /// buttons, inside the chip.
    private func chip(_ chat: LiveChat, focused: Bool) -> some View {
        HStack(spacing: 0) {
            open(chat) { chipLabel(chat) }
            let buttons = chipButtons(chat, focused: focused)
            if !buttons.isEmpty {
                HStack(spacing: 4) {
                    ForEach(buttons, id: \.self) { chipButton($0, chat) }
                }
                .padding(.trailing, 3)
            }
        }
        .frame(height: Self.chipHeight)
        .background(focused ? Self.raised : Self.surface, in: Capsule())
        .overlay { if focused { Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 1) } }
    }

    private func chipLabel(_ chat: LiveChat) -> some View {
        let title = showsText ? (chat.title.isEmpty ? chat.short : chat.title) : ""
        let running = chat.state == .working || chat.state == .needsYou
        return HStack(spacing: 5) {
            LiveStatusGlyph(state: chat.state, size: 10, ink: .black)
                .frame(width: 18, height: 18)
                .background(chat.state.tint, in: Circle())
            if !title.isEmpty {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                    .frame(maxWidth: 76, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .privacySensitive()
            }
            if running, let start = chat.startedAt { elapsed(since: start) }
        }
        .padding(.leading, 5)
        .padding(.trailing, 8)
        .frame(height: Self.chipHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: title.isEmpty ? chat.state.label : "\(title), \(chat.state.label)"))
        .accessibilityAddTraits(.isLink)
    }

    /// The tap that opens a chat: a link on the card, inert in the Settings preview.
    @ViewBuilder
    private func open(_ chat: LiveChat, @ViewBuilder label: () -> some View) -> some View {
        if interactive {
            Link(destination: Self.chatURL(chat.id), label: label)
        } else {
            label()
        }
    }

    private enum ChipButton: Hashable { case deny, allow, close, mic }

    /// What a chip carries: Deny (and Allow from Standard up) while its tool
    /// waits, the close check once it finished, and at Detailed the mic on the
    /// focused chat. A working chat has none: Stop is in the app.
    private func chipButtons(_ chat: LiveChat, focused: Bool) -> [ChipButton] {
        var out: [ChipButton] = []
        switch chat.state {
        case .needsYou where chat.callId != nil: out = showsText ? [.deny, .allow] : [.deny]
        case .done, .failed: out = [.close]
        default: break
        }
        if Self.showsMic, level == .detailed, chat.id == focus?.id, !state.listening { out.append(.mic) }
        return out
    }

    @ViewBuilder
    private func chipButton(_ kind: ChipButton, _ chat: LiveChat) -> some View {
        switch kind {
        case .deny:
            if let callId = chat.callId {
                button(AnswerApprovalIntent(sessionId: chat.id, callId: callId, allow: false)) {
                    round(CrossGlyph(), fill: Self.raised, ink: Self.danger)
                }
                .accessibilityLabel(Text("Deny"))
            }
        case .allow:
            if let callId = chat.callId {
                button(AllowToolIntent(sessionId: chat.id, callId: callId)) {
                    round(CheckGlyph(), fill: Self.accent, ink: Self.onAccent)
                }
                .accessibilityLabel(Text("Allow"))
            }
        case .close:
            let failed = chat.state == .failed
            let word = chat.closeWord.isEmpty ? closeWord(for: chat.id, failed: failed) : chat.closeWord
            button(DismissChatIntent(sessionId: chat.id)) {
                round(CheckGlyph(), fill: failed ? Self.raised : Self.accent, ink: failed ? .white : Self.onAccent)
            }
            // The words in the state are English; the catalog has them (a push may send others).
            .accessibilityLabel(Text(LocalizedStringKey(word)))
            .accessibilityHint(Text("Removes this chat from the card"))
        case .mic:
            micButton(chat)
        }
    }

    private func round(_ glyph: some Shape, fill: Color, ink: Color) -> some View {
        glyph.stroke(ink, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .frame(width: 11, height: 11)
            .frame(width: Self.buttonSize, height: Self.buttonSize)
            .background(fill, in: Circle())
    }

    /// The chats past the chips ("+3"). It opens the app's chat list.
    @ViewBuilder
    private func moreChip(_ more: Int) -> some View {
        let label = Text(verbatim: "+\(more)")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Self.grey)
            .padding(.horizontal, 10)
            .frame(height: Self.chipHeight)
            .background(Self.surface, in: Capsule())
            .accessibilityLabel(Text("\(more) more chats"))
        if interactive {
            Link(destination: Self.chatsURL) { label }
        } else {
            label
        }
    }

    // MARK: Detail line

    /// The focused chat's second line, under the chips (Standard up): its live
    /// step; at Detailed the reply line once it stops ("Finished" says less) and
    /// what the mic sent. Nil at Minimal, which shows no chat text.
    private func detail(_ chat: LiveChat) -> String? {
        guard showsText else { return nil }
        let running = chat.state == .working || chat.state == .needsYou
        if level == .detailed, !state.heard.isEmpty { return state.heard }
        if level == .detailed, !running, !chat.reply.isEmpty { return chat.reply }
        return chat.step.isEmpty ? nil : chat.step
    }

    /// Marked with the focused chip's status, so it reads as that chat's line; it opens the chat too.
    private func detailLine(_ chat: LiveChat, _ text: String) -> some View {
        open(chat) {
            HStack(spacing: 5) {
                LiveStatusGlyph(state: chat.state, size: 10)
                Text(text).lineLimit(1).privacySensitive()
            }
            .font(.system(size: 11))
            .foregroundStyle(Self.grey)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
    }

    // MARK: Mic and dictation

    private func micButton(_ chat: LiveChat) -> some View {
        Group {
            if #available(iOS 18, *) {
                button(TalkToChatIntent(sessionId: chat.id)) { mic }
            } else if interactive {
                Link(destination: Self.listenURL(chat.id)) { mic }
            } else {
                mic
            }
        }
        .accessibilityLabel(Text("Talk to this chat"))
    }

    private var mic: some View {
        MicGlyph().stroke(Self.accent, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .frame(width: 12, height: 12)
            .frame(width: Self.buttonSize, height: Self.buttonSize)
            .background(Self.raised, in: Circle())
    }

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
        Text(timerInterval: start...Date.distantFuture, countsDown: false)
            .font(.system(size: 11, weight: .medium))
            .monospacedDigit()
            .foregroundStyle(Self.grey)
            .frame(maxWidth: 44, alignment: .leading)
            .fixedSize()
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

/// The chips, left to right, wrapping onto the next line when one does not fit.
/// Each chip is as wide as it wants to be (its title is capped), never wider
/// than the line.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let lines = arrange(subviews, width: width)
        let height = lines.map(\.height).reduce(0, +) + spacing * CGFloat(max(lines.count - 1, 0))
        let used = lines.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? used, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for (index, size) in line.items {
                subviews[index].place(at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += line.height + spacing
        }
    }

    private struct Line {
        var items: [(Int, CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for index in subviews.indices {
            var size = subviews[index].sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            let next = line.items.isEmpty ? size.width : line.width + spacing + size.width
            if !line.items.isEmpty, next > width {
                lines.append(line)
                line = Line()
            }
            line.width = line.items.isEmpty ? size.width : line.width + spacing + size.width
            line.height = max(line.height, size.height)
            line.items.append((index, size))
        }
        if !line.items.isEmpty { lines.append(line) }
        return lines
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
