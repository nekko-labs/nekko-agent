import Foundation

/// Display-only recognition of the continuation envelope, never an arbitrary heading.
/// Original messages remain intact for the model, copying and later expansion.
public enum ConversationContext {
    public static func parts(_ text: String) -> (summary: String, prompt: String?)? {
        guard text.trimmingCharacters(in: .whitespacesAndNewlines)
            .hasPrefix("Summary of the earlier conversation, compacted to save context:") else { return nil }
        // The host can merge the next user prompt after the summary. Never fold that prompt.
        // Use the last separator so a horizontal rule within the summary stays in the summary.
        if let separator = text.range(of: "\n\n---\n\n", options: .backwards) {
            return (String(text[..<separator.lowerBound]), String(text[separator.upperBound...]))
        }
        return (text, nil)
    }

    public static func isSummary(_ text: String) -> Bool { parts(text) != nil }
}
