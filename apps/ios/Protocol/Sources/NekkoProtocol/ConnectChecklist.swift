import Foundation

/// New chat's "Nekko can do more with these" (#2921): a checklist over someone's
/// first message, then a one-line note while nothing is connected. Each row's
/// `done` names what got connected; the app fills them from the paired computers,
/// the active computer's folders and this phone's connectors.
public enum ConnectChecklist {
    public enum Item: String, CaseIterable, Sendable {
        case computer, folder, git, tasks
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let item: Item
        /// What got connected ("MacBook Pro", "GitHub"); nil while it isn't.
        public let done: String?
        /// A folder lives on a computer, so its row waits for one.
        public let waiting: Bool
        public var id: Item { item }
        public var isDone: Bool { done != nil }
    }

    public enum Shown: Equatable, Sendable {
        case checklist([Row])
        case note
        case nothing
    }

    public static func rows(computer: String?, folder: String?, git: String?, tasks: String?) -> [Row] {
        [
            Row(item: .computer, done: computer, waiting: false),
            Row(item: .folder, done: folder, waiting: computer == nil && folder == nil),
            Row(item: .git, done: git, waiting: false),
            Row(item: .tasks, done: tasks, waiting: false),
        ]
    }

    /// The checklist until the first message is sent and while a row is left; after it,
    /// the note only when no computer, folder or git provider is connected. Closing hides both.
    public static func shown(computer: String?, folder: String?, git: String?, tasks: String?,
                             sentBefore: Bool, closed: Bool) -> Shown {
        guard !closed else { return .nothing }
        let all = rows(computer: computer, folder: folder, git: git, tasks: tasks)
        if !sentBefore { return all.allSatisfy(\.isDone) ? .nothing : .checklist(all) }
        return computer == nil && folder == nil && git == nil ? .note : .nothing
    }

    /// Whether someone has sent a message before: a chat anywhere with an exchange.
    /// A chat whose count is unknown (an older computer) counts as used, as the first-prompt intro does.
    public static func sentBefore(remembered: Bool, exchangeCounts: [Int64?]) -> Bool {
        remembered || exchangeCounts.contains { $0 != 0 }
    }
}
