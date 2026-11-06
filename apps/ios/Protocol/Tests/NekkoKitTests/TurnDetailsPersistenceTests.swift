import Foundation
import Testing
@testable import NekkoKit
@testable import NekkoProtocol

@MainActor
struct TurnDetailsPersistenceTests {
    static let stats: JSONValue = [
        "providerId": "used-provider", "modelId": "used-model", "effort": "high",
        "inputTokens": 100, "outputTokens": 50, "outputMs": 1000, "wallMs": 5000,
        "calls": 2, "stop": "complete", "secret": "NEVER-SAVE-THIS",
    ]
    static let raw: JSONValue = [
        "id": "s", "title": "Measured reply", "providerId": "selected-provider", "modelId": "selected-model",
        "messages": [["id": "u", "role": "user", "content": "earlier"],
                     ["id": "a", "role": "assistant", "content": "Hi", "turnStats": stats]],
    ]

    @Test("Metrics survive consented offline persistence, unknown metadata does not")
    func savedRoundTrip() throws {
        let files = MemoryTranscriptCache()
        let cache = SavedTranscripts()
        cache.use(files, computerId: "pc")
        let s = try #require(Session.from(Self.raw))
        cache.save(s)
        let restored = try #require(cache.saved("s"))
        #expect(restored.session.messages == s.messages)
        #expect(restored.session.messages.last?.turnStats?.modelId == "used-model")
        let raw = files.files.values.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(raw.contains("turnStats"))
        #expect(!raw.contains("NEVER-SAVE-THIS"))
    }

    @Test("No transcript consent means no metric writes")
    func consentOff() throws {
        let files = MemoryTranscriptCache()
        let cache = SavedTranscripts()
        cache.use(nil, computerId: "pc")
        cache.save(try #require(Session.from(Self.raw)))
        #expect(cache.saved("s") == nil)
        #expect(files.writes == 0)
        #expect(cache.chatIds.isEmpty)
    }

    @Test("A finished live reply keeps its footer after saved ids are carried across reloads")
    func carriedFooter() async throws {
        let (store, connection) = try await ChatModelTests.makeOnline()
        let chat = ChatModel(sessionId: "s", store: store, now: { 42 })
        await chat.start()?.value
        defer { chat.stop() }
        chat.onEvent(.text(sessionId: "s", delta: "Hi"))
        let shown = try #require(chat.blocks.last?.id)
        #expect(shown.hasPrefix("live-"))
        #expect(chat.turnDetails.isEmpty, "a running reply has no invented persisted stats")
        connection.replies[Channels.sessionGet] = { _ in Self.raw }
        chat.onEvent(.done(sessionId: "s", messageId: "a"))
        await chat.reloadTask?.value
        #expect(chat.blocks.last?.id == shown)
        #expect(chat.turnDetails[shown]?.stats.modelId == "used-model", "not the currently selected model")
        #expect(chat.turnDetails[shown]?.successful == true)
        #expect(chat.turnDetails["a"] == nil)
        await chat.reload()
        #expect(chat.turnDetails[shown]?.stats.effort == "high", "the mapping survives another reload")

        var changed = try #require(Self.raw.object)
        var messages = try #require(changed["messages"]?.array)
        var reply = try #require(messages[1].object)
        reply["interrupted"] = true
        var stats = try #require(Self.stats.object)
        stats["outputTokens"] = 75
        reply["turnStats"] = .object(stats)
        messages[1] = .object(reply)
        changed["messages"] = .array(messages)
        let revised = JSONValue.object(changed)
        connection.replies[Channels.sessionGet] = { _ in revised }
        await chat.reload()
        #expect(chat.turnDetails[shown]?.stats.outputTokens == 75, "a metric-only reload refreshes the same footer")
        #expect(chat.turnDetails[shown]?.successful == false)

        reply["turnStats"] = nil
        messages[1] = .object(reply)
        changed["messages"] = .array(messages)
        let legacy = JSONValue.object(changed)
        connection.replies[Channels.sessionGet] = { _ in legacy }
        chat.onEvent(.done(sessionId: "s", messageId: "a"))
        await chat.reloadTask?.value
        #expect(chat.turnDetails.isEmpty, "done alone never invents stats or a success checkmark")
    }
}
