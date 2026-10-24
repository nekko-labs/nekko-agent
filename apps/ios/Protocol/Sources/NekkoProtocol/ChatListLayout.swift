import Foundation

/// How the phone's chat list arranges its chats: what it groups them by, the
/// order inside each group, and what it shows. The desktop Agents panel's view
/// menu (apps/desktop/src/renderer/views/agentPanelView.ts) on the iPhone, kept
/// as a phone preference rather than a computer setting.
///
/// The defaults are the list as it was: by project, in the desktop's dragged
/// order (newest first for the rest), with previews, completed chats and every
/// project folder shown.
public struct ChatListView: Codable, Equatable, Sendable {
    public enum GroupBy: String, Codable, CaseIterable, Sendable { case project, status, date, none }
    /// No "Date created" as on the desktop: the phone's summaries carry only the last update.
    public enum SortBy: String, Codable, CaseIterable, Sendable { case manual, updated, name }

    public var groupBy: GroupBy = .project
    public var sortBy: SortBy = .manual
    /// Manual order has no direction: it is whatever was dragged on the computer.
    public var ascending = false
    /// The last reply (or first prompt) under each title.
    public var showPreviews = true
    /// Completed chats, after their group's active ones (in a Completed group when not by project).
    public var showCompleted = true
    /// Project folders with no chats in them.
    public var showEmptyGroups = true

    public init() {}

    public static let standard = ChatListView()
    public var isStandard: Bool { self == .standard }

    /// Groups keep a dragged order only when they are the project folders; the
    /// status and date groups have a fixed order.
    public var canReorderGroups: Bool { groupBy == .project }

    /// Pick a sort. Names start A to Z and dates newest first, as on the desktop.
    public func withSort(_ s: SortBy) -> ChatListView {
        guard s != sortBy else { return self }
        var v = self
        v.sortBy = s
        v.ascending = s == .name
        return v
    }

    public static func parse(_ data: Data?) -> ChatListView {
        guard let data, let v = try? JSONDecoder().decode(ChatListView.self, from: data) else { return .standard }
        return v
    }

    public var encoded: Data? { try? JSONEncoder().encode(self) }

    private enum CodingKeys: String, CodingKey { case groupBy, sortBy, ascending, showPreviews, showCompleted, showEmptyGroups }

    /// A saved view keeps every field that is still valid; the rest fall back to the defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = ChatListView.standard
        groupBy = (try? c.decodeIfPresent(GroupBy.self, forKey: .groupBy)) ?? d.groupBy
        sortBy = (try? c.decodeIfPresent(SortBy.self, forKey: .sortBy)) ?? d.sortBy
        ascending = (try? c.decodeIfPresent(Bool.self, forKey: .ascending)) ?? d.ascending
        showPreviews = (try? c.decodeIfPresent(Bool.self, forKey: .showPreviews)) ?? d.showPreviews
        showCompleted = (try? c.decodeIfPresent(Bool.self, forKey: .showCompleted)) ?? d.showCompleted
        showEmptyGroups = (try? c.decodeIfPresent(Bool.self, forKey: .showEmptyGroups)) ?? d.showEmptyGroups
    }
}

/// One group of the chat list as the view arranges it.
public struct ChatSection: Equatable, Sendable, Identifiable {
    public static let completedKey = "__completed"
    public let key: String
    public let name: String
    /// Active chats in the view's order, then completed ones (most recently completed first).
    public let chats: [SessionSummary]
    public let activeCount: Int
    public let doneCount: Int
    public var id: String { key }
}

public enum ChatSections {
    /// A group shows at most this many chats before "Show more"...
    public static let shownLimit = 8
    /// ...and only those touched in this window (ms).
    public static let recentWindow: Int64 = 14 * 24 * 60 * 60 * 1000

    /// The status groups, most urgent first.
    public static let statusGroups: [GroupDef] = [
        GroupDef("status:input", "Needs you"), GroupDef("status:working", "Working"), GroupDef("status:idle", "Idle"),
    ]

    /// The date groups, newest first, counted in local calendar days.
    public static let dateGroups: [GroupDef] = [
        GroupDef("date:today", "Today"), GroupDef("date:yesterday", "Yesterday"), GroupDef("date:week", "Previous 7 days"),
        GroupDef("date:month", "Previous 30 days"), GroupDef("date:older", "Older"),
    ]

    public struct GroupDef: Sendable {
        public let key: String
        public let name: String
        init(_ key: String, _ name: String) { self.key = key; self.name = name }
    }

    /// The list's groups for `view`. Project groups follow `groupOrder` (folder
    /// ids and `ChatGroup.general`, as dragged on the phone); folders it doesn't
    /// name keep the computer's order after the ones it does.
    public static func make(_ chats: [SessionSummary], folders: [WorkspaceFolder], view: ChatListView,
                            activity: [String: Activity], groupOrder: [String] = [],
                            now: Int64, calendar: Calendar = .current) -> [ChatSection] {
        let sort = compare(view)
        let done: ([SessionSummary]) -> [SessionSummary] = { list in
            view.showCompleted ? list.filter(\.archived).sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) } : []
        }
        func section(_ key: String, _ name: String, active: [SessionSummary], completed: [SessionSummary]) -> ChatSection {
            ChatSection(key: key, name: name, chats: active + completed, activeCount: active.count, doneCount: completed.count)
        }

        if view.groupBy == .project {
            let groups = ChatGroup.of(chats, folders: folders).compactMap { g -> ChatSection? in
                let active = view.sortBy == .manual ? g.active : g.active.sorted(by: sort)
                let s = section(g.key, g.name, active: active, completed: done(g.completed))
                // General is listed only when it has chats; a folder unless empty ones are hidden.
                if s.chats.isEmpty && (g.key == ChatGroup.general || !view.showEmptyGroups) { return nil }
                return s
            }
            let order = ChatGroupOrder.apply(groups.map(\.key), saved: groupOrder)
            return order.compactMap { k in groups.first { $0.key == k } }
        }

        let active = chats.filter { !$0.archived }.sorted(by: sort)
        let completedAll = done(chats)
        let completed = completedAll.isEmpty ? [] : [section(ChatSection.completedKey, "Completed", active: [], completed: completedAll)]
        if view.groupBy == .none {
            return (active.isEmpty ? [] : [section("all", "All chats", active: active, completed: [])]) + completed
        }
        let defs = view.groupBy == .status ? statusGroups : dateGroups
        let groupOf: (SessionSummary) -> String = view.groupBy == .status
            ? { statusKey(activity[$0.id]) }
            : { dateKey($0.updatedAt, now: now, calendar: calendar) }
        let grouped = Dictionary(grouping: active, by: groupOf)
        return defs.compactMap { d in
            let items = grouped[d.key] ?? []
            return items.isEmpty && !view.showEmptyGroups ? nil : section(d.key, d.name, active: items, completed: [])
        } + completed
    }

    /// The chats a group shows before "Show more", and how many that leaves out:
    /// up to `shownLimit` touched within `recentWindow`, in order. A chat that
    /// is working, needs you or is pinned is always shown.
    public static func split(_ s: ChatSection, activity: [String: Activity], now: Int64) -> (shown: [SessionSummary], hidden: Int) {
        let since = now - recentWindow
        var shown: [SessionSummary] = []
        var hidden = 0
        for c in s.chats {
            let always = activity[c.id] != nil || c.pinned
            let recent = max(c.updatedAt, c.archivedAt ?? 0) >= since
            if always || (recent && shown.count < shownLimit) { shown.append(c) } else { hidden += 1 }
        }
        return (shown, hidden)
    }

    public static func statusKey(_ a: Activity?) -> String {
        switch a {
        case .needsYou?: return "status:input"
        case .running?: return "status:working"
        case nil: return "status:idle"
        }
    }

    public static func dateKey(_ at: Int64, now: Int64, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(at) / 1000)
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: TimeInterval(now) / 1000))
        func daysBack(_ n: Int) -> Date { calendar.date(byAdding: .day, value: -n, to: today) ?? today }
        if date >= today { return "date:today" }
        if date >= daysBack(1) { return "date:yesterday" }
        if date >= daysBack(7) { return "date:week" }
        if date >= daysBack(30) { return "date:month" }
        return "date:older"
    }

    /// Active chats in the view's order. Manual: dragged ones first, then most recent.
    static func compare(_ view: ChatListView) -> (SessionSummary, SessionSummary) -> Bool {
        switch view.sortBy {
        case .manual:
            return { a, b in
                switch (a.order, b.order) {
                case let (x?, y?) where x != y: return x < y
                case (.some, .none): return true
                case (.none, .some): return false
                default: return a.updatedAt > b.updatedAt
                }
            }
        case .updated:
            return { a, b in view.ascending ? a.updatedAt < b.updatedAt : a.updatedAt > b.updatedAt }
        case .name:
            return { a, b in
                let r = a.title.localizedStandardCompare(b.title)
                if r == .orderedSame { return a.updatedAt > b.updatedAt }
                return view.ascending ? r == .orderedAscending : r == .orderedDescending
            }
        }
    }
}

/// The project groups' order as dragged on the phone.
public enum ChatGroupOrder {
    /// `keys` in the saved order; keys the saved order doesn't name follow, in their own order.
    public static func apply(_ keys: [String], saved: [String]) -> [String] {
        let present = Set(keys)
        let known = saved.filter(present.contains)
        let seen = Set(known)
        return known + keys.filter { !seen.contains($0) }
    }

    /// Move `key` to just before `target` (to the end when nil). Unchanged when either is unknown.
    public static func move(_ keys: [String], _ key: String, before target: String?) -> [String] {
        guard keys.contains(key), key != target else { return keys }
        var out = keys.filter { $0 != key }
        if let target {
            guard let i = out.firstIndex(of: target) else { return keys }
            out.insert(key, at: i)
        } else {
            out.append(key)
        }
        return out
    }
}
