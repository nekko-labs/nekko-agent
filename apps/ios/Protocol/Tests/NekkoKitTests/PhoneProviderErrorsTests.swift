import Foundation
import XCTest
@testable import NekkoKit

/// Failed answers explained by their error code, never by the provider's own words (#2920).
final class PhoneProviderErrorsTests: XCTestCase {
    private func body(_ s: String) -> Data { Data(s.utf8) }

    func testNoCreditIsNotCalledRateLimiting() {
        let quota = body(#"{"error":{"message":"You exceeded your current quota sk-proj-abc","type":"insufficient_quota","code":"insufficient_quota"}}"#)
        let openai = PhoneProviders.failure(status: 429, body: quota, kind: "openai")
        XCTAssertTrue(openai.contains("no credit"))
        XCTAssertTrue(openai.contains("platform.openai.com"))
        XCTAssertFalse(openai.contains("sk-proj"))
        let other = PhoneProviders.failure(status: 429, body: quota, kind: "openai-compat")
        XCTAssertTrue(other.contains("no credit"))
        XCTAssertFalse(other.contains("platform.openai.com"))
        XCTAssertTrue(PhoneProviders.failure(status: 402, body: body(#"{"error":{"code":402,"message":"Insufficient credits"}}"#)).contains("no credit"))
    }

    func testRateLimitsSayHowLongToWait() {
        let limited = body(#"{"error":{"type":"requests","code":"rate_limit_exceeded","message":"Limit reached"}}"#)
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: limited, headers: ["Retry-After": "7"]), "Rate limited. Try again in 7s.")
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: limited, headers: ["x-ratelimit-reset-requests": "6m0s", "x-ratelimit-reset-tokens": "20ms"]), "Rate limited. Try again in 1s.")
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: limited, headers: ["x-ratelimit-reset-tokens": "6m0s"]), "Rate limited. Try again in 6 min.")
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: Data()), "Rate limited. Try again in a moment.")
        let anthropic = body(#"{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded"}}"#)
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: anthropic, headers: ["retry-after": "30"]), "Rate limited. Try again in 30s.")
        let gemini = body(#"[{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}]"#)
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: gemini), "Rate limited. Try again in a moment.")
    }

    func testModelKeyAndBusyCodes() {
        let model = PhoneProviders.failure(status: 404, body: body(#"{"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}"#))
        XCTAssertTrue(model.contains("can’t use that model"))
        XCTAssertFalse(model.contains("gpt-9"))
        let key = PhoneProviders.failure(status: 401, body: body(#"{"error":{"message":"Incorrect API key provided: sk-abc***xyz","code":"invalid_api_key"}}"#))
        XCTAssertTrue(key.contains("401"))
        XCTAssertFalse(key.contains("sk-abc"))
        XCTAssertTrue(PhoneProviders.failure(status: 529, body: body(#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#)).contains("busy"))
        XCTAssertEqual(PhoneProviders.failure(status: 404, body: Data()), "The provider doesn’t know that address or model (404)")
        XCTAssertEqual(PhoneProviders.failure(status: 500, body: body("not json")), "The provider answered 500")
    }

    func testAnOversizedBodyIsNotRead() {
        let big = body(#"{"error":{"code":"insufficient_quota","pad":""# + String(repeating: "x", count: 5000) + #""}}"#)
        XCTAssertEqual(PhoneProviders.failure(status: 429, body: big), "Rate limited. Try again in a moment.")
    }

    func testDurations() {
        XCTAssertEqual(PhoneProviders.duration("1s"), 1)
        XCTAssertEqual(PhoneProviders.duration("6m0s"), 360)
        XCTAssertEqual(PhoneProviders.duration("20ms"), 0.02)
        XCTAssertEqual(PhoneProviders.duration("1h2m3.5s"), 3723.5)
        XCTAssertNil(PhoneProviders.duration("12"))
        XCTAssertNil(PhoneProviders.duration("2026-11-17T08:00:00Z"))
    }

    func testRateLimitHeaders() throws {
        let openai = try XCTUnwrap(PhoneRateLimits.from(headers: [
            "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "120ms",
            "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "21808", "x-ratelimit-reset-tokens": "16.38s",
        ], at: 1_000_000))
        XCTAssertEqual(openai, PhoneRateLimits(requestsLimit: 500, requestsRemaining: 499, requestsResetAt: 1_000_120,
                                               tokensLimit: 30000, tokensRemaining: 21808, tokensResetAt: 1_016_380, at: 1_000_000))
        let anthropic = try XCTUnwrap(PhoneRateLimits.from(headers: [
            "Anthropic-Ratelimit-Requests-Limit": "50", "anthropic-ratelimit-requests-remaining": "49",
            "anthropic-ratelimit-requests-reset": "2026-11-17T08:00:01Z", "anthropic-ratelimit-tokens-remaining": "9000",
        ], at: 5))
        XCTAssertEqual(anthropic.requestsLimit, 50)
        XCTAssertEqual(anthropic.requestsRemaining, 49)
        XCTAssertEqual(anthropic.tokensRemaining, 9000)
        XCTAssertEqual(anthropic.requestsResetAt, Int64(ISO8601DateFormatter().date(from: "2026-11-17T08:00:01Z")!.timeIntervalSince1970 * 1000))
        XCTAssertNil(PhoneRateLimits.from(headers: ["content-type": "application/json", "x-ratelimit-remaining-requests": "-3"], at: 1))
    }

    func testDefaultModelIsTheNewestPlainChatModel() {
        // OpenAI's list as the phone sorts it, reverse by id, with OpenAI's `created` dates.
        let list = [
            PhoneModel(id: "o3-2025-04-16", name: "o3-2025-04-16", created: 1_744_000_000),
            PhoneModel(id: "o3", name: "o3", created: 1_744_000_000),
            PhoneModel(id: "gpt-live-1", name: "gpt-live-1", created: 1_790_000_000),
            PhoneModel(id: "gpt-6.1-terra", name: "gpt-6.1-terra", created: 1_788_000_000),
            PhoneModel(id: "gpt-6.1-sol", name: "gpt-6.1-sol", created: 1_788_500_000),
            PhoneModel(id: "gpt-6-sol", name: "gpt-6-sol", created: 1_780_000_000),
            PhoneModel(id: "gpt-5.5-pro-2026-04-23", name: "gpt-5.5-pro-2026-04-23", created: 1_791_000_000),
            PhoneModel(id: "gpt-5.5-pro", name: "gpt-5.5-pro", created: 1_791_000_000),
        ]
        XCTAssertEqual(PhoneProviders.defaultModel(list)?.id, "gpt-6.1-sol")
        // No dates: the list's own order, minus snapshots.
        XCTAssertEqual(PhoneProviders.defaultModel([PhoneModel(id: "claude-x-20250514", name: "x"), PhoneModel(id: "claude-opus-5-5", name: "Opus")])?.id, "claude-opus-5-5")
        // Only snapshots: still something.
        XCTAssertEqual(PhoneProviders.defaultModel([PhoneModel(id: "o3-2025-04-16", name: "o3")])?.id, "o3-2025-04-16")
        XCTAssertNil(PhoneProviders.defaultModel([]))
    }

    func testModelsKeepOpenAIsCreatedDate() {
        let data = Data(#"{"data":[{"id":"gpt-6.1-sol","created":1788500000},{"id":"o3"}]}"#.utf8)
        XCTAssertEqual(PhoneProviders.models(from: data, kind: "openai"), [PhoneModel(id: "o3", name: "o3"), PhoneModel(id: "gpt-6.1-sol", name: "gpt-6.1-sol", created: 1_788_500_000)])
    }
}

@MainActor
final class PhoneProviderErrorFlowTests: XCTestCase {
    private let models = #"{"data":[{"id":"o3-2025-04-16","created":1744000000},{"id":"gpt-6.1-sol","created":1788500000}]}"#
    private let quota = #"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#

    /// OpenAI lists models for a key with no credit; Test asks the default model for a few tokens too.
    func testOpenAIKeyWithNoCreditFailsTheTest() async throws {
        let http = FakePhoneHTTP()
        http.answers = [(200, [models]), (429, [quota])]
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        let why = await s.test(p.id)
        XCTAssertEqual(why, "This key has no credit. Add billing at platform.openai.com, then try again.")
        let check = try XCTUnwrap(http.requests.last)
        XCTAssertEqual(check.url, "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(check.body?["model"]?.string, "gpt-6.1-sol")
        XCTAssertEqual(check.body?["max_completion_tokens"]?.int64, 16)
        XCTAssertNil(check.body?["stream"])
        XCTAssertEqual(check.headers["Authorization"], "Bearer k")

        let ok = FakePhoneHTTP()
        ok.answers = [(200, [models]), (200, [#"{"choices":[{"message":{"content":"OK"}}]}"#])]
        let t = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: ok)
        let q = try t.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        let passed = await t.test(q.id)
        XCTAssertNil(passed)
        XCTAssertEqual(ok.requests.count, 2)
    }

    func testAFailedReplyReadsTheErrorCodeAndAWait() async throws {
        let http = FakePhoneHTTP()
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http)
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        http.answers = [(429, [quota])]
        let id = s.create(providerId: p.id, modelId: "gpt-6.1-sol", first: "Test!")
        await s.settled(id)
        XCTAssertEqual(s.chat(id)?.messages.last?.error, "This key has no credit. Add billing at platform.openai.com, then try again.")

        http.answers = [(429, [#"{"error":{"code":"rate_limit_exceeded","message":"slow down"}}"#])]
        http.headers = [[:], ["retry-after": "12"]]
        s.retry(id)
        await s.settled(id)
        XCTAssertEqual(s.chat(id)?.messages.last?.error, "Rate limited. Try again in 12s.")
    }

    func testAReplyRecordsTheKeysLimits() async throws {
        let http = FakePhoneHTTP()
        let s = PhoneChats(secrets: MemoryStore(), files: MemoryOfflineFiles(), http: http, now: { 1_000 })
        let p = try s.add(kind: "openai", label: "OpenAI", baseUrl: nil, key: "k")
        http.answers = [(200, [#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#, "data: [DONE]"])]
        http.headers = [["x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "29000", "x-ratelimit-reset-tokens": "2s"]]
        let id = s.create(providerId: p.id, modelId: "gpt-6.1-sol", first: "Hi")
        await s.settled(id)
        XCTAssertEqual(s.rateLimits[p.id], PhoneRateLimits(tokensLimit: 30000, tokensRemaining: 29000, tokensResetAt: 3_000, at: 1_000))
        s.remove(p.id)
        XCTAssertNil(s.rateLimits[p.id])
    }
}
