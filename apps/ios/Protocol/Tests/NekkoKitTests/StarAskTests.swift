import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

/// The GitHub star ask's rules (spec/platform/github-star-ask.md), the same cases
/// as `packages/shared/src/support.test.ts`.
struct StarAskTests {
    /// Prompt numbers whose reply carries the card, over `prompts` prompts, ignoring every card.
    private func asks(over prompts: Int, from start: StarAsk = StarAsk()) -> [Int] {
        var state = start
        var shown: [Int] = []
        for _ in 0..<prompts {
            let (next, show) = state.afterReply()
            state = next
            if show { shown.append(state.prompts) }
        }
        return shown
    }

    @Test("The same numbers as the desktop")
    func numbers() {
        #expect(StarAsk.at == [10, 50])
    }

    @Test("Asks at exactly 10 and 50 over 120 prompts")
    func asksAtTenAndFifty() {
        #expect(asks(over: 120) == [10, 50])
    }

    @Test("Stopped never asks again")
    func stopEndsIt() {
        var state = StarAsk()
        for _ in 0..<10 { state = state.afterReply().state }
        state = state.stop()
        #expect(asks(over: 100, from: state).isEmpty)
        #expect(!StarAsk(prompts: 50, asked: 1, stopped: true).due)
        #expect(asks(over: 60, from: .never).isEmpty, "UI test runs start stopped")
    }

    @Test("Not now after the first ask: the second comes at 50, then never")
    func notNow() {
        var state = StarAsk()
        for _ in 0..<10 { state = state.afterReply().state }
        #expect(state == StarAsk(prompts: 10, asked: 1))
        #expect(asks(over: 200, from: state) == [50])
    }

    @Test("A late first ask uses up the second too, so two never come back to back")
    func lateFirstAsk() {
        // The card never got its chance until past 50 (say the count came from a newer app).
        let late = StarAsk(prompts: 59, asked: 0)
        let (state, show) = late.afterReply()
        #expect(show)
        #expect(state == StarAsk(prompts: 60, asked: 2))
        #expect(asks(over: 100, from: state).isEmpty)
        // Between the two, only the first is used up.
        #expect(StarAsk(prompts: 30, asked: 0).shown().asked == 1)
    }

    @Test("Reading is defensive: anything malformed is a fresh start")
    func defensiveReading() {
        #expect(StarAsk.parse(nil) == StarAsk())
        #expect(StarAsk.parse("") == StarAsk())
        #expect(StarAsk.parse("not json") == StarAsk())
        #expect(StarAsk.parse("[1,2]") == StarAsk())
        #expect(StarAsk.parse("null") == StarAsk())
        #expect(StarAsk.parse(#"{"prompts":-3,"asked":"two","stopped":"yes"}"#) == StarAsk())
        #expect(StarAsk.parse(#"{"prompts":true,"asked":1e400}"#) == StarAsk())
        #expect(StarAsk.parse(#"{"prompts":12.7,"asked":1}"#) == StarAsk(prompts: 12, asked: 1))
        #expect(StarAsk.parse(#"{"prompts":12,"asked":1,"stopped":true}"#) == StarAsk(prompts: 12, asked: 1, stopped: true))
        #expect(StarAsk.parse(#"{"asked":7}"#) == StarAsk(prompts: 0, asked: 7))
        #expect(!StarAsk.parse(#"{"prompts":500,"asked":7}"#).due, "past both asks")
    }

    @Test("What it stores reads back, in the desktop's shape")
    func roundTrip() {
        for state in [StarAsk(), StarAsk(prompts: 10, asked: 1), StarAsk(prompts: 51, asked: 2, stopped: true)] {
            #expect(StarAsk.parse(state.encoded) == state)
        }
        #expect(StarAsk(prompts: 10, asked: 1).encoded == #"{"prompts":10,"asked":1}"#)
        #expect(StarAsk(prompts: 3, asked: 0, stopped: true).encoded == #"{"prompts":3,"asked":0,"stopped":true}"#)
    }
}

/// What the chat screen counts toward the ask: a prompt sent from it whose reply finished.
@MainActor
struct StarAskCountTests {
    /// The computer lists each prompt it took, so every send here goes straight to it.
    private final class Listed { var ids: [JSONValue] = [] }

    private func online() async throws -> (ComputersStore, FakeConnection) {
        let (s, c) = try await ChatModelTests.makeOnline()
        let listed = Listed()
        c.replies[Channels.chatSend] = { args in listed.ids.append(args.first?["clientMessageId"] ?? .null); return .null }
        c.replies[Channels.sessionGet] = { _ in ["id": "s", "title": "T", "messages": [], "queue": [], "clientMessageIds": .array(listed.ids)] }
        return (s, c)
    }

    /// Send, and let the computer's answer settle (the reply's events come separately).
    private func send(_ chat: ChatModel, _ text: String) async throws {
        _ = try await chat.send(text)
        await chat.sendTask?.value
    }
    @Test("A sent prompt counts once its reply is done")
    func doneCounts() async throws {
        let (s, _) = try await online()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        try await send(chat, "hello")
        #expect(chat.promptsSent == 1)
        chat.onEvent(.text(sessionId: "s", delta: "Hi"))
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        #expect(chat.promptReplies == 1)
        // A second done for the same turn, or another chat's, adds nothing.
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        chat.onEvent(.done(sessionId: "other", messageId: nil))
        #expect(chat.promptReplies == 1)
        chat.stop()
    }

    @Test("A failed or stopped reply does not count")
    func failuresAndStopsDoNot() async throws {
        let (s, _) = try await online()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        try await send(chat, "fails")
        chat.onEvent(.error(sessionId: "s", message: "Provider error"))
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        try await send(chat, "stopped")
        chat.abort()
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        try await send(chat, "stopped on the computer")
        chat.onEvent(.error(sessionId: "s", message: "Stopped"))
        #expect(chat.promptReplies == 0)
        #expect(chat.promptsSent == 3)
        chat.stop()
    }

    @Test("A turn this screen did not start (an automation, a resend) does not count")
    func otherTurnsDoNot() async throws {
        let (s, _) = try await online()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        chat.onEvent(.text(sessionId: "s", delta: "From an automation"))
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        #expect(chat.promptReplies == 0)
        chat.stop()
    }

    @Test("A follow-up queued mid-reply does not count; the reply it waited on does")
    func queuedDoesNot() async throws {
        let (s, c) = try await online()
        let chat = ChatModel(sessionId: "s", store: s)
        await chat.start()?.value
        c.replies[Channels.chatQueue] = { _ in ["id": "s", "title": "T", "messages": [], "queue": ["later"]] }
        try await send(chat, "first")
        #expect(chat.running)
        _ = try await chat.send("later")
        #expect(chat.promptsSent == 2)
        #expect(c.callsTo(Channels.chatQueue).count == 1, "it was queued")
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        #expect(chat.promptReplies == 1, "the first prompt's reply")
        // The queued prompt then runs as the computer's own turn.
        chat.onEvent(.text(sessionId: "s", delta: "Queued reply"))
        chat.onEvent(.done(sessionId: "s", messageId: nil))
        #expect(chat.promptReplies == 1)
        chat.stop()
    }
}
