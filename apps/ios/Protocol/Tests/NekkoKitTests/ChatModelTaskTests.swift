import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

/// The chat's entry points hand back the work they start, so a test awaits it
/// instead of yielding and sleeping until it has probably finished (#1412).
@MainActor
struct ChatModelTaskTests {
    @Test("Starting a chat returns its first read, skills included")
    func startReturnsTheFirstRead() async throws {
        let (s, _) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        #expect(chat.title == "T")
        #expect(chat.skills.map(\.name) == ["review"])
        #expect(chat.start() == nil, "a second start does nothing")
        chat.stop()
    }

    @Test("A prompt the computer refuses settles in the send's task")
    func refusedSendSettlesInItsTask() async throws {
        let (s, c) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: s, now: { 7 })
        await chat.start()?.value
        c.replies[Channels.chatSend] = { _ in throw RelayError("Not now.", fromComputer: true) }
        _ = try await chat.send("draft")
        await chat.sendTask?.value
        #expect(!chat.running)
        #expect(chat.takeUnsent()?.text == "draft")
        chat.stop()
    }
}
