import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

/// A computer whose `chat:send` takes the prompt at once but answers only when
/// the turn ends, as a real one does (here: not within the test).
final class LongTurnComputer: Caller, @unchecked Sendable {
    let inner = FakeComputer(chats: ["s"])

    func call(_ channel: String, _ args: [JSONValue], timeout: TimeInterval?) async throws -> JSONValue {
        let reply = try inner.handle(channel, args)
        if channel == Channels.chatSend { try await Task.sleep(nanoseconds: 120_000_000_000) }
        return reply
    }
}

/// How the outbox confirms a send (#1412): woken by the computer's first event
/// for the chat or by the send's answer, with a backoff in between, never by
/// re-reading the chat on a fixed short tick or spinning on the main actor.
@MainActor
struct OutboxConfirmTests {
    func outbox(_ caller: Caller, poll: TimeInterval, timeout: TimeInterval) -> Outbox {
        let drafts = DraftStore(files: nil, debounce: 0)
        drafts.load("c1")
        let o = Outbox(files: nil, drafts: drafts, caller: { caller },
                       defaults: { RemoteDefaults(defaultProviderId: "p", defaultModelId: "m") },
                       pollInterval: poll, confirmTimeout: timeout)
        o.load("c1")
        return o
    }

    @Test("The computer's first event for the chat confirms the send at once")
    func firstEventConfirms() async {
        let computer = LongTurnComputer()
        // A tick far longer than the test: only the event can end the wait.
        let o = outbox(computer, poll: 60, timeout: 600)
        o.add(chatId: "s", text: "hi")
        let flush = Task { await o.flush() }
        while computer.inner.count(Channels.chatSend) == 0 { await Task.yield() }
        o.onEvent(.text(sessionId: "s", delta: "Hi"))
        o.onEvent(.text(sessionId: "s", delta: " there"))
        await flush.value
        #expect(o.items.isEmpty)
        // One read before sending (is it running?), one after the event: the second token woke nothing.
        #expect(computer.inner.count(Channels.sessionGet) == 2)
    }

    @Test("An event for another chat does not wake the wait")
    func otherChatsDoNotWake() async {
        let computer = LongTurnComputer()
        let o = outbox(computer, poll: 0.05, timeout: 600)
        o.add(chatId: "s", text: "hi")
        let flush = Task { await o.flush() }
        while computer.inner.count(Channels.chatSend) == 0 { await Task.yield() }
        o.onEvent(.text(sessionId: "other", delta: "x"))
        await flush.value
        // Confirmed by the backoff's first re-read instead.
        #expect(o.items.isEmpty)
        #expect(computer.inner.count(Channels.sessionGet) == 2)
    }

    @Test("A wait ends at a fire, at its time, or at once after a fire nobody waited for")
    func wake() async {
        let w = Wake()
        let start = Date()
        Task { w.fire() }
        await w.wait(60)
        #expect(Date().timeIntervalSince(start) < 30)

        await w.wait(0.01)

        w.fire()
        let again = Date()
        await w.wait(60)
        #expect(Date().timeIntervalSince(again) < 30)
    }
}
