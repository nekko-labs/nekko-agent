import Foundation

/// When the message box's `/` menu (the computer's skills and saved prompts)
/// opens, and what picking from it leaves in the box. Mirrors the desktop's
/// `composerSkills.ts`.
public enum SlashMenu {
    /// What the menu searches for, and the text typed before its `/`.
    public struct Trigger: Equatable, Sendable {
        /// The word after the `/`, possibly empty. Matching is the caller's.
        public let query: String
        /// Everything before the `/`: empty for a message that starts with it.
        public let before: String
        /// The whole message is the `/` query (it starts with `/`).
        public var atStart: Bool { before.isEmpty }
    }

    /// The menu's query, or nil when it stays shut. A message that starts with
    /// `/` searches the whole message while it has no space (as before); any
    /// other message opens it for a `/word` at its end, after a space or line
    /// break. `a/b`, `https://x.com/` and a `/` followed by a space do not.
    public static func trigger(_ draft: String) -> Trigger? {
        if draft.hasPrefix("/") {
            return draft.contains(" ") ? nil : Trigger(query: String(draft.dropFirst()), before: "")
        }
        guard let slash = draft.lastIndex(of: "/") else { return nil }
        let query = draft[draft.index(after: slash)...]
        guard !query.contains(where: \.isWhitespace), slash > draft.startIndex,
              draft[draft.index(before: slash)].isWhitespace else { return nil }
        return Trigger(query: String(query), before: String(draft[..<slash]))
    }

    /// The box's text once a skill is picked: the `/query` goes, what was typed before it stays.
    public static func textAfterSkill(_ draft: String) -> String {
        trigger(draft)?.before ?? draft
    }

    /// The box's text once a saved prompt is picked after existing text: the
    /// `/query` becomes the prompt's text. (A message that is only the `/query`
    /// arms the prompt as a chip instead, and the box empties.)
    public static func textAfterPrompt(_ draft: String, promptText: String) -> String {
        guard let t = trigger(draft) else { return draft }
        return t.atStart ? "" : t.before + promptText
    }
}
