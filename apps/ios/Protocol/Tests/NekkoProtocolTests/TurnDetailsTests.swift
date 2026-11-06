import Foundation
import Testing
@testable import NekkoProtocol

struct TurnDetailsTests {
    static let measured: JSONValue = [
        "providerId": "actual-provider", "modelId": "actual-model", "effort": "xhigh",
        "inputTokens": 1000, "cacheReadTokens": 200, "cacheWriteTokens": 100,
        "outputTokens": 500, "outputMs": 10000, "wallMs": 50000, "calls": 3, "stop": "complete",
        "secret": "must-not-follow", "providerPayload": ["prompt": "must-not-follow"],
    ]

    static func message(_ stats: JSONValue? = measured, interrupted: Bool = false, tools: Bool = false) -> ChatMessage {
        var v: [String: JSONValue] = ["id": "saved-reply", "role": "assistant", "content": tools ? "" : "Finished.", "interrupted": .bool(interrupted)]
        v["turnStats"] = stats
        if tools { v["toolCalls"] = [["id": "call-1", "name": "read_file", "input": [:]], ["id": "call-2", "name": "read_file", "input": [:]]] }
        return ChatMessage.from(.object(v))!
    }

    @Test("Parse persisted metrics, include cache in input, never retain unknown payloads")
    func narrowProjection() throws {
        let m = Self.message()
        let details = try #require(TurnDetails(message: m))
        #expect(details.successful)
        #expect(details.stats.tokensPerSecond == 50)
        #expect(details.parts == ["actual-model · actual-provider", "Extra high effort", "1.3k in", "500 out", "50 tok/s", "50s"])
        #expect(!details.stats.json.serialized().contains("must-not-follow"))
        #expect(TurnStats.from(details.stats.json) == details.stats)
        #expect(Self.message(nil).turnStats == nil)
        #expect(m != Self.message(nil), "metric-only reloads change message equality")
    }

    @Test("Decode rate uses provider time at least 100ms, never elapsed time")
    func decodeRate() throws {
        for ms: JSONValue? in [nil, .null, .int(0), .int(99), .int(-1), .double(.infinity), .double(.nan), .string("1000")] {
            var o = Self.measured.object!
            o["outputMs"] = ms
            #expect(try #require(TurnStats.from(.object(o))).tokensPerSecond == nil)
        }
        var o = Self.measured.object!
        o["outputMs"] = 100
        #expect(try #require(TurnStats.from(.object(o))).tokensPerSecond == 5000)
        o["outputTokens"] = 0
        #expect(try #require(TurnStats.from(.object(o))).tokensPerSecond == nil)
        o["inputTokens"] = -1
        #expect(TurnStats.from(.object(o)) == nil)
    }

    @Test("Only explicit complete and non-interrupted persisted replies get a checkmark")
    func successSemantics() throws {
        for stop: JSONValue? in [nil, .null, .string("loop"), .string("runaway"), .string("unknown")] {
            var o = Self.measured.object!
            o["stop"] = stop
            #expect(try #require(TurnDetails(message: Self.message(.object(o)))).successful == false)
        }
        #expect(try #require(TurnDetails(message: Self.message(interrupted: true))).successful == false)
        #expect(TurnDetails(message: Self.message(nil)) == nil, "legacy replies do not acquire an invented success")
    }

    @Test("Footer identity follows carried live ids and tool-only replies anchor after their last call")
    func footerAssociation() throws {
        let reply = Self.message()
        let map = TurnDetails.footers([reply], shownIds: ["saved-reply": "live-42-0"])
        #expect(map["saved-reply"] == nil)
        #expect(map["live-42-0"]?.id == "saved-reply")
        let tools = Self.message(tools: true)
        let toolMap = TurnDetails.footers([tools], shownIds: ["saved-reply": "live-42-0"])
        #expect(toolMap.keys.sorted() == ["call-2"])
        #expect(toolMap["call-2"]?.stats.modelId == "actual-model")
        #expect(Transcript.fromMessages([tools]).map(\.id) == ["call-1", "call-2"])
    }

    @Test("Stats-only replies retain a footer anchor, user messages never accept stats")
    func emptyAndNonAssistant() {
        var o: [String: JSONValue] = ["id": "empty", "role": "assistant", "content": "", "turnStats": Self.measured]
        #expect(Transcript.fromMessages([ChatMessage.from(.object(o))!]).map(\.id) == ["empty"])
        o["role"] = "user"
        let user = ChatMessage.from(.object(o))!
        #expect(user.turnStats == nil)
        #expect(TurnDetails.footers([user]).isEmpty)
    }
}
