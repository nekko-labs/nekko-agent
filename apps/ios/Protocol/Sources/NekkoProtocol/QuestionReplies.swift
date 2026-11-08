import Foundation

/// Display-only replies, projected after saved/live reconciliation so they never
/// become prompt anchors, duplicate model messages, or change a running turn.
public enum QuestionReplies {
    public static func body(name: String, output: String?) -> String? {
        let prefix = "The user answered:\n\n"
        let suffix = "\n\nWork to these answers. Do not ask again about anything settled here."
        guard name == "ask_user", let output, output.hasPrefix(prefix), output.hasSuffix(suffix) else { return nil }
        let body = String(output.dropFirst(prefix.count).dropLast(suffix.count))
        return body.hasPrefix("Q: ") && body.contains("\nA: ") ? body : nil
    }

    public static func project(_ blocks: [Block]) -> [Block] {
        var out: [Block] = []
        var seen = Set<String>()
        for block in blocks {
            out.append(block)
            if case .tool(let id, let name, _, .ok, let output, _) = block,
               seen.insert(id).inserted, let text = body(name: name, output: output) {
                out.append(.user(id: "ask-answer:\(id)", text: text, at: nil, images: 0))
            }
        }
        return out
    }
}
