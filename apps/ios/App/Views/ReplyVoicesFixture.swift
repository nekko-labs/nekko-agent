#if DEBUG
import NekkoProtocol
import SwiftUI

/// UI-test fixture (`-uiTestReplyVoices`, Debug builds only): a working turn and
/// a plain one, drawn by the chat's real `BlockView` with the chat's own
/// padding, as evidence for spec/chat/thinking-and-replies.md.
struct ReplyVoicesFixture: View {
    @Environment(\.palette) private var palette

    private static let blocks: [Block] = [
        .user(id: "prompt", text: "The login test is flaky on CI. Fix it.", at: nil, images: 0),
        say("note", "I'll read the test and the page it waits on first."),
        tool("read1", "read_file", "tests/login.spec.ts", key: "path"),
        tool("read2", "grep", "waitForTimeout", key: "pattern"),
        say("ask", "The signup test has the same fixed timer.\n\nShould I fix it there too, or keep this change to login?"),
        tool("test1", "bash", "npm test -- login", key: "command"),
        say("reply", "**Changes**\n- The login test waits for the sign-in request instead of a fixed 500 ms timer.\n\n"
            + "**Verified**\n- `npm test -- login` passed 5 runs in a row.\n\n"
            + "**Decision**: kept the 10 s overall timeout.\n\n"
            + "**Run this**\n```bash\nnpm test -- login\n```\n\nWant me to open the PR?"),
        .user(id: "prompt2", text: "What did the old timer do?", at: nil, images: 0),
        say("plain", "It waited half a second and hoped the page had loaded. On a slow runner it often had not."),
    ]

    private static func say(_ id: String, _ text: String) -> Block {
        .assistant(id: id, text: text, reasoning: nil, streaming: false, interrupted: false)
    }

    private static func tool(_ id: String, _ name: String, _ value: String, key: String) -> Block {
        .tool(id: id, name: name, label: value, status: .ok, output: "ok", input: [key: .string(value)])
    }

    private var blocks: [Block] {
        if ProcessInfo.processInfo.arguments.contains("-uiTestQuietContext") {
            return [.user(id: "context", text: "Summary of the earlier conversation, compacted to save context:\n\n## Task and workspace\nThe long workspace context stays available on demand.", at: nil, images: 0)] + Self.blocks
        }
        return Self.blocks
    }

    var body: some View {
        let voices = Dictionary(uniqueKeysWithValues: zip(blocks.map(\.id), ReplyTopics.voices(blocks)))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(TranscriptRow.of(blocks)) { row in
                    switch row {
                    case .block(let block): BlockView(block: block, voice: voices[block.id] ?? nil)
                    case .agents(let blocks): ForEach(blocks) { BlockView(block: $0) }
                    case .purpose(let purpose, let items, let calls):
                        PurposeGroupRow(purpose: purpose, blocks: items, calls: calls) { BlockView(block: $0) }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        // `-scrollEnd` photographs the bottom of the transcript.
        .defaultScrollAnchor(ProcessInfo.processInfo.arguments.contains("-scrollEnd") ? .bottom : .top)
        .background(palette.paper)
    }
}
#endif
