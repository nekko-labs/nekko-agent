import Foundation

/// Pictures an agent made with `generate_image` or `edit_image` (#2973). The
/// computer keeps a tool result's pictures off the phone's chat view and says
/// how many it left out (`omittedImages`); the phone asks for each one on
/// demand (`session:photo` on the tool's result message), and the computer
/// serves only these two tools' pictures. Another tool's images (a screenshot
/// of the computer) are never offered, so the phone never asks for them.
public enum ToolPictures {
    public static let tools: Set<String> = ["generate_image", "edit_image"]

    /// The tool-result message that holds a call's pictures, and how many.
    public struct Found: Equatable, Sendable {
        public let messageId: String
        public let count: Int
    }

    public static func find(_ messages: [ChatMessage], callId: String, tool name: String) -> Found? {
        guard tools.contains(name) else { return nil }
        for m in messages where m.role == "tool" {
            guard let r = m.toolResult, r.toolCallId == callId, !r.isError, r.omittedImages > 0 else { continue }
            return Found(messageId: m.id, count: r.omittedImages)
        }
        return nil
    }
}
