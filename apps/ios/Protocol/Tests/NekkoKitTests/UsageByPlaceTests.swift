import Foundation
import XCTest
@testable import NekkoKit
@testable import NekkoProtocol

/// #1773: Usage and limits by where it came from (each paired computer, and
/// this iPhone's own chats), and within a place by subscription versus API.
@MainActor
final class UsageByPlaceTests: XCTestCase {
    let key = "00112233445566778899aabbccddeeff"
    var connections: [FakeConnection] = []
    var http = FakePhoneHTTP()
    var files = MemoryOfflineFiles()
    var secrets = MemoryStore()

    // MARK: The phone's streams

    func testTheStreamsReportTheirTokens() async {
        let p = PhoneStreamParser()
        // Anthropic: the prompt's tokens (cache included) at the start, the reply's as a running total.
        XCTAssertEqual(p.read(#"data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":1}}}"#),
                       [.usage(input: 125, output: 1)])
        XCTAssertEqual(p.read(#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#),
                       [.usage(input: nil, output: 42)])
        XCTAssertEqual(p.read(#"data: {"type":"message_start","message":{"id":"m"}}"#), [])
        // OpenAI: the last chunk has no choices and the whole reply's usage; the others say nothing.
        XCTAssertEqual(p.read(#"data: {"choices":[{"delta":{"content":"Hi"}}],"usage":null}"#), [.text("Hi")])
        XCTAssertEqual(p.read(#"data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":7,"total_tokens":37}}"#),
                       [.usage(input: 30, output: 7)])

        var count = PhoneTokenCount()
        for e in [PhoneStreamEvent.usage(input: 125, output: 1), .text("x"), .usage(input: nil, output: 42)] { count.add(e) }
        XCTAssertEqual(count.input, 125)
        XCTAssertEqual(count.output, 42, "the running total, not a sum")
        XCTAssertTrue(count.reported)
    }

    func testOnlyOpenAiAndOpenRouterAreAskedForUsage() async {
        let msgs = [PhoneMessage(id: "1", role: .user, text: "Hi", at: 1)]
        func body(_ kind: String) -> JSONValue? {
            PhoneProviders.chatRequest(PhoneProvider(id: "x", kind: kind, label: "X", baseUrl: "https://x.example/v1"), key: "k", model: "m", messages: msgs).body
        }
        XCTAssertEqual(body("openai")?["stream_options"]?["include_usage"]?.bool, true)
        XCTAssertEqual(body("openrouter")?["stream_options"]?["include_usage"]?.bool, true)
        XCTAssertNil(body("openai-compat")?["stream_options"], "a compatible server may turn down a field it doesn't know")
        XCTAssertNil(body("anthropic")?["stream_options"])
    }

    // MARK: The phone's ledger

    func makePhone() -> PhoneChats {
        var n = 0
        // 2026-11-05, midday UTC, then a second on each call.
        var t: Int64 = 1_793_880_000_000
        return PhoneChats(secrets: secrets, files: files, http: http, now: { t += 1000; return t }, newId: { n += 1; return "m\(n)" })
    }

    func testThePhoneRecordsWhatEachReplyUsedAndKeepsItOnThePhone() async throws {
        let s = makePhone()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k2")
        http.answers = [
            (200, [#"data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}"#,
                   #"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"#,
                   #"data: {"type":"message_delta","usage":{"output_tokens":20}}"#,
                   #"data: {"type":"message_stop"}"#]),
            (200, [#"data: {"type":"message_start","message":{"usage":{"input_tokens":150,"output_tokens":1}}}"#,
                   #"data: {"type":"message_delta","usage":{"output_tokens":30}}"#,
                   #"data: {"type":"message_stop"}"#]),
            (200, [#"data: {"choices":[{"delta":{"content":"Hey"}}]}"#,
                   #"data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":10}}"#,
                   "data: [DONE]"]),
        ]
        let a = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Hi")
        await s.settled(a)
        s.send(a, "More")
        await s.settled(a)
        let o = s.create(providerId: "openai", modelId: "gpt-5", first: "Hi")
        await s.settled(o)

        XCTAssertEqual(s.usage.entries.count, 2, "one entry per provider, model and day")
        let place = s.usage.place()
        XCTAssertEqual(place.kind, .phone)
        XCTAssertEqual(place.id, PhoneProviders.computerId)
        XCTAssertFalse(place.priced, "the phone has no price table")
        XCTAssertNil(place.apiCost)
        XCTAssertEqual(place.totalTokens, 250 + 50 + 50)
        XCTAssertTrue(place.subscriptionModels.isEmpty, "the phone's providers are API keys")
        XCTAssertEqual(place.apiGroups.map(\.label), ["Claude", "OpenAI"], "by provider, the busiest first")
        XCTAssertEqual(place.apiGroups.first?.models.first?.input, 250)
        XCTAssertEqual(place.apiGroups.first?.models.first?.output, 50)
        XCTAssertEqual(place.summary?.days.map(\.tokens), [350])

        // Kept on the phone, in a file of its own, and read back on the next launch.
        XCTAssertNotNil(files.files["this-iphone/phone-usage"])
        XCTAssertEqual(makePhone().usage, s.usage)

        // Forget everything takes it too.
        s.forgetAll()
        XCTAssertTrue(s.usage.isEmpty)
        XCTAssertNil(files.files["this-iphone/phone-usage"])
        XCTAssertTrue(makePhone().usage.isEmpty)
    }

    func testAStoppedReplyStillCountsWhatTheProviderReported() async throws {
        let s = makePhone()
        try s.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        http.hang = true
        http.answers = [(200, [#"data: {"type":"message_start","message":{"usage":{"input_tokens":80,"output_tokens":1}}}"#,
                               #"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Part"}}"#])]
        let id = s.create(providerId: "claude", modelId: "claude-opus-5-5", first: "Long one")
        for _ in 0..<50 where s.chat(id)?.messages.last?.text.isEmpty != false { try await Task.sleep(nanoseconds: 2_000_000) }
        s.stop(id)
        await s.settled(id)
        XCTAssertEqual(s.usage.place().totalTokens, 81)
    }

    func testTheLedgerAddsUpByDayAndForgetsOldDays() async {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let day: Int64 = 86_400_000
        let start: Int64 = 1_793_880_000_000 // 2026-11-05
        var l = PhoneUsageLedger()
        l.record(providerId: "c", providerLabel: "Claude", model: "opus", input: 10, output: 5, at: start, calendar: utc)
        l.record(providerId: "c", providerLabel: "Claude", model: "opus", input: 1, output: 1, at: start + 60_000, calendar: utc)
        l.record(providerId: "c", providerLabel: "Claude", model: "opus", input: 0, output: 0, at: start, calendar: utc)
        XCTAssertEqual(l.entries.count, 1, "the same day adds up; nothing used, nothing recorded")
        XCTAssertEqual(l.entries.first?.day, "2026-11-05")
        XCTAssertEqual(l.entries.first?.input, 11)
        l.record(providerId: "c", providerLabel: "Claude 2", model: "opus", input: 3, output: 0, at: start + day, calendar: utc)
        XCTAssertEqual(l.place().summary?.days.map(\.date), ["2026-11-05", "2026-11-06"])
        XCTAssertEqual(l.place().apiGroups.map(\.label), ["Claude 2"], "the provider's latest name")
        // Over ninety days on, those days are gone.
        l.record(providerId: "o", providerLabel: "OpenAI", model: "gpt-5", input: 1, output: 1, at: start + 92 * day, calendar: utc)
        XCTAssertEqual(l.entries.map(\.providerId), ["o"])
    }

    // MARK: Every place

    /// Each computer (room) answers with its own usage: `aaaa` has a Claude plan and some API use, `bbbb` API only.
    func makeStore() -> ComputersStore {
        var n = 0
        return ComputersStore(
            store: secrets,
            makeConnection: { cfg in
                let c = FakeConnection(config: cfg)
                let plan = cfg.room == "aaaa"
                c.replies = [
                    Channels.sessionsSummaries: { _ in [] },
                    Channels.providersList: { _ in
                        plan ? [["id": "claude", "kind": "claude-code", "label": "Claude", "enabled": true],
                                ["id": "oa", "kind": "openai", "label": "OpenAI", "enabled": true],
                                ["id": "off", "kind": "codex", "label": "Off", "enabled": false]]
                            : [["id": "oa", "kind": "openai", "label": "OpenAI", "enabled": true]]
                    },
                    Channels.usageSummary: { _ in
                        plan ? ["totalInput": 700, "totalOutput": 350, "totalCost": 0.5,
                                "byModel": [["model": "Claude Opus 5.5", "input": 600, "output": 300, "cost": 0, "subscription": true],
                                            ["model": "GPT-5", "input": 100, "output": 50, "cost": 0.5]],
                                "daily": [["date": "2026-11-04", "input": 700, "output": 350, "cost": 0.5]]]
                            : ["totalInput": 1000, "totalOutput": 1000, "totalCost": 2,
                               "byModel": [["model": "GPT-5", "input": 1000, "output": 1000, "cost": 2]], "daily": []]
                    },
                    Channels.limitsGet: { args in
                        args.first?.string == "claude"
                            ? ["planType": "max", "windows": [["id": "five", "label": "5 hours", "usedPercent": 40, "status": "allowed"]]]
                            : .null
                    },
                ]
                self.connections.append(c)
                return c
            },
            deviceName: { "iPhone" },
            deriveKey: { _, _ in Data(repeating: 7, count: 32) },
            newId: { n += 1; return "id-\(n)" },
            now: { 1_000 },
            summariesDebounce: 0.01,
            stayConnected: true)
    }

    /// Two computers, two host keys: a known host key is the same computer re-paired.
    func link(_ room: String) -> PairingLink {
        PairingLink(relayUrl: "wss://relay.example", room: room, key: key,
                    hostKey: room == "aaaa" ? testHostKey : otherTestHostKey, pair: nil)
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        for _ in 0..<20 { await Task.yield() }
    }

    func testEveryPlaceIsGroupedBySubscriptionThenApi() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        await settle()
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        cb.online()
        await settle()
        XCTAssertEqual(s.activeId, b)

        let phone = makePhone()
        try phone.add(kind: "anthropic", label: "Claude", baseUrl: nil, key: "k")
        let m = FleetUsageModel(store: s, phone: phone)
        await m.load()

        XCTAssertEqual(m.places.map(\.id), s.computers.map(\.id) + [PhoneProviders.computerId], "the computers in order, then this iPhone")
        let pa = try XCTUnwrap(m.places.first { $0.id == a })
        XCTAssertTrue(pa.online)
        XCTAssertEqual(pa.plans.map(\.providerId), ["claude"], "only providers that reported limits; enabled ones only asked")
        XCTAssertEqual(pa.plans.first?.title, "Claude · Max")
        XCTAssertEqual(pa.subscriptionModels.map(\.model), ["Claude Opus 5.5"])
        XCTAssertEqual(pa.apiGroups.flatMap(\.models).map(\.model), ["GPT-5"])
        XCTAssertNil(pa.apiGroups.first?.label, "a computer's summary names only the model")
        XCTAssertEqual(pa.subscriptionTokens, 900)
        XCTAssertEqual(pa.apiTokens, 150)
        XCTAssertEqual(pa.apiCost, 0.5)
        XCTAssertFalse(ca.callsTo(Channels.limitsGet).contains { $0.first?.string == "off" })
        // The fleet computer was read over its own link, not the active one.
        XCTAssertEqual(ca.callsTo(Channels.usageSummary).count, 1)
        XCTAssertEqual(cb.callsTo(Channels.usageSummary).count, 1)

        let pb = try XCTUnwrap(m.places.first { $0.id == b })
        XCTAssertTrue(pb.plans.isEmpty)
        XCTAssertEqual(pb.apiTokens, 2000)

        let ph = try XCTUnwrap(m.places.last)
        XCTAssertEqual(ph.kind, .phone)
        XCTAssertNil(ph.summary, "set up, nothing used yet")

        XCTAssertEqual(m.total.tokens, 1050 + 2000)
        XCTAssertEqual(m.total.subscriptionTokens, 900)
        XCTAssertEqual(m.total.apiTokens, 150 + 2000)
        XCTAssertEqual(m.total.apiCost, 2.5, accuracy: 0.0001)
        XCTAssertEqual(m.total.offline, 0)
    }

    func testAnOfflineComputerSaysSoAndKeepsItsLastNumbers() async throws {
        let s = makeStore()
        s.load()
        let a = try await s.pair(link("aaaa"))
        let ca = try XCTUnwrap(connections.last)
        ca.online()
        await settle()
        let b = try await s.pair(link("bbbb"))
        let cb = try XCTUnwrap(connections.last)
        cb.online()
        await settle()

        let m = FleetUsageModel(store: s, phone: nil)
        await m.load()
        XCTAssertEqual(m.places.count, 2, "no phone place without the phone's chats")

        ca.status(RelayStatus(.offline))
        await settle()
        let asked = ca.callsTo(Channels.usageSummary).count
        await m.load()
        let pa = try XCTUnwrap(m.places.first { $0.id == a })
        XCTAssertFalse(pa.online)
        XCTAssertNil(pa.error, "offline is not an error")
        XCTAssertEqual(pa.totalTokens, 1050, "the last numbers stay")
        XCTAssertEqual(pa.plans.count, 1)
        XCTAssertEqual(ca.callsTo(Channels.usageSummary).count, asked, "nothing is sent to an offline computer")
        XCTAssertTrue(try XCTUnwrap(m.places.first { $0.id == b }).online)
        XCTAssertEqual(m.total.offline, 1)

        // A computer that never answered is listed, offline, with nothing to show.
        let fresh = FleetUsageModel(store: s, phone: nil)
        await fresh.load()
        let never = try XCTUnwrap(fresh.places.first { $0.id == a })
        XCTAssertFalse(never.online)
        XCTAssertNil(never.summary)
        XCTAssertTrue(never.isEmpty)

        // A computer that answers with an error keeps its numbers and says why.
        ca.online()
        await settle()
        ca.replies[Channels.usageSummary] = { _ in throw RelayError("Usage is off.", fromComputer: true) }
        await m.load()
        let failed = try XCTUnwrap(m.places.first { $0.id == a })
        XCTAssertFalse(failed.online)
        XCTAssertNotNil(failed.error)
        XCTAssertEqual(failed.totalTokens, 1050)
    }
}
