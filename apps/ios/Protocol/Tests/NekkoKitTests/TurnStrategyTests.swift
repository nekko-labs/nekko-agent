import Testing
@testable import NekkoKit
import NekkoProtocol

@MainActor
struct TurnStrategyTests {
    private func session(_ strategy: JSONValue?) throws -> Session {
        var user: [String: JSONValue] = ["id": "u", "role": "user", "content": "Check the build"]
        user["turnStrategy"] = strategy
        return try #require(Session.from([
            "id": "s", "updatedAt": 42,
            "messages": [.object(user), ["id": "a", "role": "assistant", "content": "Okay"]],
        ]))
    }

    @Test func strategyOnlyReloadWritesOfflineCopy() async throws {
        let files = MemoryTranscriptCache()
        let cache = SavedTranscripts()
        cache.use(files, computerId: "pc")
        let legacy = try session(nil)
        cache.save(legacy)
        await cache.flush()
        #expect(cache.saved("s")?.session.messages.first?.turnStrategy == nil)

        let revised = try session(["tools": "code", "orchestration": "coordinator", "reason": "separable", "modelId": "parent", "subagentModelId": "worker", "subagentsDeferred": true, "extra": "ignore"])
        #expect(legacy.messages != revised.messages)
        cache.save(revised)
        await cache.flush()
        let reopened = SavedTranscripts()
        reopened.use(files, computerId: "pc")
        let restored = try #require(reopened.saved("s"))
        #expect(restored.session.messages == revised.messages)
        #expect(restored.session.messages.first?.turnStrategy?.json == ["tools": "code", "orchestration": "coordinator", "reason": "separable", "modelId": "parent", "subagentModelId": "worker", "subagentsDeferred": true])
    }

    @Test func sectionsIncludeRepeatedModes() throws {
        func message(_ id: String, _ strategy: JSONValue?, role: String = "user") throws -> ChatMessage {
            var raw: [String: JSONValue] = ["id": .string(id), "role": .string(role)]
            raw["turnStrategy"] = strategy
            return try #require(ChatMessage.from(.object(raw)))
        }
        let messages = try [
            message("old", nil),
            message("u1", ["tools": "code", "orchestration": "direct", "reason": "not-needed"]),
            message("a", ["tools": "list", "orchestration": "worker"], role: "assistant"),
            message("future", ["tools": "future", "orchestration": "direct"]),
            message("u2", ["tools": "code", "orchestration": "direct", "reason": "off"]),
            message("u3", ["tools": "code", "orchestration": "coordinator", "reason": "unknown"]),
            message("u4", ["tools": "list", "orchestration": "coordinator"]),
            message("u5", ["tools": "claude-code", "orchestration": "external"]),
        ]
        let sections = TurnStrategy.sections(messages, shownIds: ["u1": "live-u1"])
        #expect(Set(sections.keys) == ["live-u1", "u2", "u3", "u4", "u5"])
        #expect(messages[2].turnStrategy == nil)
        #expect(messages[3].turnStrategy == nil)
        #expect(sections["u3"]?.reason == nil)
        #expect(sections["u5"]?.orchestration == .external)
        #expect(TurnStrategy.sections(Array(messages.prefix(1))).isEmpty)
    }
}
