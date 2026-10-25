import Foundation

/// What one pane of the folding-phone layout shows
/// (spec/phone/folding-phones-two-chats-and-monitors.md, *Panes*). Other
/// routes (Files, Settings, a computer's page) open inside a pane's own
/// navigation and are not part of what is remembered.
public enum PaneContent: Equatable, Hashable, Sendable {
    /// The chat list.
    case chats
    /// One chat on the computer.
    case chat(String)
    /// New chat, which becomes the chat once it starts.
    case newChat
    /// The computer's Monitors (hardware, running chats, needs you, automations).
    case monitors
    /// A chat pane with no chat picked yet.
    case empty

    /// `chats`, `monitors`, `newChat`, `empty` or `chat:<id>`.
    public var encoded: String {
        switch self {
        case .chats: return "chats"
        case .chat(let id): return "chat:" + id
        case .newChat: return "newChat"
        case .monitors: return "monitors"
        case .empty: return "empty"
        }
    }

    public init?(encoded: String) {
        switch encoded {
        case "chats": self = .chats
        case "newChat": self = .newChat
        case "monitors": self = .monitors
        case "empty": self = .empty
        default:
            guard encoded.hasPrefix("chat:") else { return nil }
            let id = String(encoded.dropFirst("chat:".count))
            guard !id.isEmpty else { return nil }
            self = .chat(id)
        }
    }

    public var chatId: String? {
        if case .chat(let id) = self { return id }
        return nil
    }

    /// A chat, New chat or an empty chat pane: where a chat opened from elsewhere lands.
    public var holdsChat: Bool {
        switch self {
        case .chat, .newChat, .empty: return true
        case .chats, .monitors: return false
        }
    }
}

extension PaneContent: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let c = PaneContent(encoded: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown pane content \(raw)"))
        }
        self = c
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(encoded)
    }
}

/// The arrangements the pane header offers (*Replace with…* → Arrangement).
public enum PaneArrangement: String, CaseIterable, Sendable {
    /// Two chats side by side (or stacked).
    case chatChat
    /// A chat beside the computer's Monitors.
    case chatMonitors
    /// The chat list beside one chat: the default, and today's iPad layout.
    case chatsChat
    /// Monitors beside the chat list.
    case monitorsChats
}

/// One of the two panes. Its `id` stays with it when the panes swap or the
/// phone rotates, so the view inside (a chat and its scroll position) is
/// moved rather than rebuilt.
public struct Pane: Equatable, Sendable, Identifiable, Codable {
    public let id: String
    public var content: PaneContent

    public init(id: String, content: PaneContent) {
        self.id = id
        self.content = content
    }
}

/// The two panes, how the space is shared, which one has the keyboard, and
/// whether one fills the screen (Focus). Remembered per computer on the phone
/// (never sent anywhere).
public struct PaneLayout: Equatable, Sendable, Codable {
    /// Leading (or top) first. Always two.
    public private(set) var panes: [Pane]
    /// The first pane's share of the width (or height) on a screen without a hinge.
    public private(set) var split: Double
    /// The pane with the keyboard focus: its composer takes the keyboard.
    public private(set) var focusedId: String
    /// Focus: this pane fills the screen and the other is an edge tab.
    public private(set) var maximizedId: String?

    /// The divider drags between 35 / 65 and 65 / 35.
    public static let minSplit = 0.35
    public static let maxSplit = 0.65

    /// The two pane ids.
    public static let firstId = "a"
    public static let secondId = "b"

    public init(panes: [Pane], split: Double, focusedId: String, maximizedId: String? = nil) {
        precondition(panes.count == 2 && panes[0].id != panes[1].id, "a layout has two distinct panes")
        self.panes = panes
        self.split = Self.clamp(split)
        self.focusedId = panes.contains { $0.id == focusedId } ? focusedId : panes[1].id
        self.maximizedId = maximizedId.flatMap { id in panes.contains { $0.id == id } ? id : nil }
    }

    /// The first open: the chat list beside a chat pane, the chat pane focused (iPad's layout until now).
    public static let standard = PaneLayout(
        panes: [Pane(id: firstId, content: .chats), Pane(id: secondId, content: .empty)],
        split: 0.4, focusedId: secondId)

    public static func clamp(_ split: Double) -> Double {
        guard split.isFinite else { return 0.5 }
        return min(maxSplit, max(minSplit, split))
    }

    // MARK: Reading

    public var first: Pane { panes[0] }
    public var second: Pane { panes[1] }
    public var focused: Pane { panes.first { $0.id == focusedId } ?? panes[1] }

    public func pane(_ id: String) -> Pane? { panes.first { $0.id == id } }
    public func other(_ id: String) -> Pane { panes[0].id == id ? panes[1] : panes[0] }

    /// Which named arrangement this is, or nil for another mix (two lists, Monitors twice, …).
    public var arrangement: PaneArrangement? {
        switch (first.content, second.content) {
        case (let a, let b) where a.holdsChat && b.holdsChat: return .chatChat
        case (let a, .monitors) where a.holdsChat: return .chatMonitors
        case (.chats, let b) where b.holdsChat: return .chatsChat
        case (.monitors, .chats): return .monitorsChats
        default: return nil
        }
    }

    /// The chat the phone shows when it closes to one column: the focused
    /// pane's, else the other pane's.
    public var focusedChatId: String? { focused.content.chatId ?? other(focusedId).content.chatId }

    // MARK: Changing

    public mutating func focus(_ id: String) {
        guard pane(id) != nil else { return }
        focusedId = id
    }

    /// The panes trade places, each keeping its size.
    public mutating func swap() {
        panes.reverse()
        split = Self.clamp(1 - split)
    }

    /// Focus: `id` fills the screen; again, both panes come back.
    public mutating func toggleMaximized(_ id: String) {
        guard pane(id) != nil else { return }
        maximizedId = maximizedId == id ? nil : id
        focusedId = id
    }

    public mutating func restoreBoth() { maximizedId = nil }

    /// The divider was dragged (clamped to 35–65).
    public mutating func setSplit(_ split: Double) { self.split = Self.clamp(split) }

    /// *Replace with…*: `id` shows `content`. When the other pane already
    /// shows it, the two trade contents instead (a chat is never in both).
    public mutating func replace(_ id: String, with content: PaneContent) {
        guard let i = panes.firstIndex(where: { $0.id == id }) else { return }
        let j = 1 - i
        if panes[j].content == content, content != .empty {
            panes[j].content = panes[i].content
        }
        panes[i].content = content
        focusedId = id
    }

    /// Show `content`, opened from pane `source` (the list, Monitors) or from
    /// outside (a notification, a link: `source` nil). A pane that already
    /// shows it is focused. Otherwise a chat lands in the focused chat pane,
    /// else another chat pane, else the pane it was not opened from; Monitors
    /// and the list replace the pane they were opened from, else the pane
    /// without a chat. Returns the pane it landed in.
    @discardableResult
    public mutating func open(_ content: PaneContent, from source: String? = nil) -> String {
        if let shown = panes.first(where: { $0.content == content && content != .empty }) {
            focusedId = shown.id
            if maximizedId != nil { maximizedId = shown.id }
            return shown.id
        }
        let target: String
        if content.holdsChat {
            let focusedChat = focused.content.holdsChat && focusedId != source ? focusedId : nil
            let anyChat = panes.first { $0.content.holdsChat && $0.id != source }?.id
            target = focusedChat ?? anyChat ?? (source.map { other($0).id } ?? other(focusedId).id)
        } else {
            // Monitors or the list takes the place of the pane it was opened from, else the pane without a chat.
            target = source ?? panes.first { !$0.content.holdsChat }?.id ?? other(focusedId).id
        }
        guard let i = panes.firstIndex(where: { $0.id == target }) else { return focusedId }
        panes[i].content = content
        focusedId = target
        if maximizedId != nil { maximizedId = target }
        return target
    }

    /// Pick an arrangement from the header menu. The chat on screen stays (in
    /// the same pane, so it keeps its place); *Chat + Chat* takes the other
    /// chat already open, else the most recent one in `recent`.
    public mutating func apply(_ arrangement: PaneArrangement, recent: [String] = []) {
        let open = panes.compactMap(\.content.chatId)
        let primary = focused.content.chatId ?? open.first
        let primaryContent: PaneContent = primary.map(PaneContent.chat) ?? (panes.contains { $0.content == .newChat } ? .newChat : .empty)
        let next: [PaneContent]
        let share: Double
        switch arrangement {
        case .chatChat:
            let second = open.first { $0 != primary } ?? recent.first { $0 != primary }
            next = [primaryContent, second.map(PaneContent.chat) ?? .empty]
            share = 0.5
        case .chatMonitors:
            next = [primaryContent, .monitors]
            share = 0.6
        case .chatsChat:
            next = [.chats, primaryContent]
            share = 0.4
        case .monitorsChats:
            next = [.monitors, .chats]
            share = 0.5
        }
        // Each content keeps the pane that already shows it.
        var ids: [String?] = next.map { c in panes.first { $0.content == c }?.id }
        if ids[0] != nil && ids[0] == ids[1] { ids[1] = nil }
        let all = panes.map(\.id)
        for k in 0..<2 where ids[k] == nil {
            ids[k] = all.first { !ids.contains($0) }
        }
        let made = zip(ids, next).map { Pane(id: $0 ?? Self.firstId, content: $1) }
        let focusTo = made.first { $0.content == primaryContent && primaryContent.holdsChat }?.id ?? made[0].id
        self = PaneLayout(panes: made, split: share, focusedId: focusTo)
    }

    /// After a rotation with two chats open, the pane that was focused is the
    /// primary one (left, or top).
    public mutating func promoteFocused() {
        guard first.content.holdsChat, second.content.holdsChat, second.id == focusedId else { return }
        swap()
    }

    /// The one-time tip: opening chat `id` while the one chat pane shows
    /// another chat that is still working offers *Chat + Chat*.
    public func offersChatChat(opening id: String, running: Set<String>) -> Bool {
        guard arrangement == .chatsChat, let shown = second.content.chatId ?? first.content.chatId else { return false }
        return shown != id && running.contains(shown)
    }

    /// Take the tip: the chat that was running and `id`, side by side.
    public mutating func takeChatChat(adding id: String) {
        guard let shown = panes.compactMap(\.content.chatId).first else {
            open(.chat(id))
            return
        }
        let chatPane = panes.first { $0.content.chatId == shown }?.id ?? Self.secondId
        let listPane = other(chatPane).id
        self = PaneLayout(panes: [Pane(id: chatPane, content: .chat(shown)), Pane(id: listPane, content: .chat(id))],
                          split: 0.5, focusedId: listPane)
    }

    // MARK: Saving

    public var encoded: Data? {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return try? e.encode(self)
    }

    /// A saved layout, or nil when there is none or it no longer reads.
    public static func parse(_ data: Data?) -> PaneLayout? {
        guard let data, let saved = try? JSONDecoder().decode(Saved.self, from: data),
              saved.panes.count == 2, saved.panes[0].id != saved.panes[1].id else { return nil }
        return PaneLayout(panes: saved.panes, split: saved.split, focusedId: saved.focusedId, maximizedId: saved.maximizedId)
    }

    private struct Saved: Decodable {
        let panes: [Pane]
        let split: Double
        let focusedId: String
        let maximizedId: String?
    }

    // MARK: On screen

    /// How the panes are laid out for `posture`
    /// (spec, *Postures* and *Vertical mode*).
    public func display(_ posture: Posture) -> PaneDisplay {
        switch posture {
        case .closed:
            return PaneDisplay(mode: .single, panes: panes, shownId: focusedId)
        case .tabletop:
            // The focused pane takes the whole screen in flex layout; the other is an edge tab.
            return PaneDisplay(mode: .single, panes: panes, shownId: focusedId, flex: true)
        case .openWide, .book:
            if let m = maximizedId { return PaneDisplay(mode: .single, panes: panes, shownId: m) }
            return PaneDisplay(mode: .sideBySide, panes: panes, shownId: focusedId)
        case .openTall:
            var shown = panes
            var behind: String?
            // The chat list is never the bottom pane: a list under a chat reads as its attachments.
            if let i = panes.firstIndex(where: { $0.content == .chats }) {
                let rest = panes[1 - i]
                if rest.content.holdsChat {
                    // Chats + Chat becomes Chat over Monitors; the list is behind the chat's back button.
                    shown = [rest, Pane(id: panes[i].id, content: .monitors)]
                    behind = rest.id
                } else if i == 1 {
                    shown = [panes[1], panes[0]]
                }
            }
            if let m = maximizedId { return PaneDisplay(mode: .single, panes: shown, shownId: m, listBehindId: behind) }
            return PaneDisplay(mode: .stacked, panes: shown, shownId: focusedId, listBehindId: behind)
        }
    }

    /// The first pane's share when a hinge divides the screen: the hinge's
    /// middle along the split axis (`hingeStart`…`hingeEnd` of `length`).
    public static func hingeSplit(hingeStart: Double, hingeEnd: Double, length: Double) -> Double? {
        guard length > 0, hingeEnd >= hingeStart, hingeStart >= 0, hingeEnd <= length else { return nil }
        return (hingeStart + hingeEnd) / 2 / length
    }
}

/// The panes as drawn for one posture.
public struct PaneDisplay: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        /// One pane fills the screen (closed, Focus, tabletop); the other is an edge tab.
        case single
        /// Left and right (open, wide; book).
        case sideBySide
        /// Top and bottom (open, tall).
        case stacked
    }

    public var mode: Mode
    /// Leading or top first, with what each shows in this posture (open, tall
    /// shows Monitors where the list was).
    public var panes: [Pane]
    /// In `single` mode, the pane on screen.
    public var shownId: String
    /// The pane whose back button opens the chat list (open, tall).
    public var listBehindId: String?
    /// Tabletop: the shown pane lays out around the hinge (transcript above, composer below).
    public var flex: Bool

    public init(mode: Mode, panes: [Pane], shownId: String, listBehindId: String? = nil, flex: Bool = false) {
        self.mode = mode
        self.panes = panes
        self.shownId = shownId
        self.listBehindId = listBehindId
        self.flex = flex
    }

    public var isSplit: Bool { mode != .single }
}

/// Tabletop flex layout: where the hinge falls in a view (`frameMinY`,
/// `frameHeight`, in the window's points). The transcript takes `top`, the
/// hinge `gap`, the composer and its cards what is left; nothing is placed
/// on the hinge. Nil when the hinge is not inside the view.
public struct PaneFlex: Equatable, Sendable {
    public let top: Double
    public let gap: Double

    public init?(hingeMinY: Double, hingeMaxY: Double, frameMinY: Double, frameHeight: Double) {
        let top = hingeMinY - frameMinY
        guard frameHeight > 0, hingeMaxY >= hingeMinY, top > 0, hingeMaxY - frameMinY < frameHeight else { return nil }
        self.top = top
        self.gap = hingeMaxY - hingeMinY
    }

    /// Where the lower half (composer, cards) starts, from the view's top.
    public var lowerStart: Double { top + gap }
}
