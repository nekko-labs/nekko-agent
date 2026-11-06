import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

/// Per-token cost of a streamed reply (#1412): a token patches the last block
/// instead of merging the transcript again, and the result is the same as a merge.
@MainActor
struct StreamingTests {
    let chat = ChatModel(sessionId: "s", store: ComputersStore(store: MemoryStore(), makeConnection: { FakeConnection(config: $0) },
                                                               deviceName: { "iPhone" }))

    @Test("A streamed token patches only the last block")
    func tokenPatchesTheLastBlock() throws {
        chat.onEvent(.text(sessionId: "s", delta: "Hel"))
        let layout = chat.blocksLayout
        let revision = chat.blocksRevision
        for delta in ["lo", " the", "re"] { chat.onEvent(.text(sessionId: "s", delta: delta)) }
        #expect(chat.blocksLayout == layout)
        #expect(chat.blocksRevision == revision + 3)
        #expect(chat.blocks == Transcript.mergeLive(saved: [], live: chat.turn.blocks))
        guard case .assistant(_, let text, _, let streaming, _) = try #require(chat.blocks.last) else {
            Issue.record("the last block is not the reply")
            return
        }
        #expect(text == "Hello there")
        #expect(streaming)
    }

    @Test("Reasoning streams the same way, and other events merge again")
    func otherEventsMerge() {
        chat.onEvent(.reasoning(sessionId: "s", delta: "Think"))
        chat.onEvent(.reasoning(sessionId: "s", delta: "ing"))
        let layout = chat.blocksLayout
        chat.onEvent(.toolCall(sessionId: "s", call: ToolCall(id: "c1", name: "read_file", input: ["path": "a.txt"])))
        #expect(chat.blocksLayout > layout)
        chat.onEvent(.text(sessionId: "s", delta: "Done"))
        #expect(chat.blocks == Transcript.mergeLive(saved: [], live: chat.turn.blocks))
        #expect(chat.blocks.map(\.id).count == 3)
    }

    @Test("The live character count matches a recount after every kind of event")
    func runningCountMatchesARecount() {
        chat.onEvent(.text(sessionId: "s", delta: "日本語 and emoji 🐈"))
        chat.onEvent(.reasoning(sessionId: "s", delta: "why"))
        chat.onEvent(.toolCall(sessionId: "s", call: ToolCall(id: "c1", name: "read_file", input: ["path": "a.txt"])))
        chat.onEvent(.text(sessionId: "s", delta: "more"))
        chat.onEvent(.retry(sessionId: "s"))
        chat.onEvent(.text(sessionId: "s", delta: "again"))
        #expect(chat.liveChars == ChatModel.characters(chat.turn.blocks))
    }
}
