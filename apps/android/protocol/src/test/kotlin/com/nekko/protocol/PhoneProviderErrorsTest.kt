package com.nekko.protocol

import org.junit.Assert.*
import org.junit.Test

/** Failed answers explained by their error code, never by the provider's own words (#2920). */
class PhoneProviderErrorsTest {
    private val quota = """{"error":{"message":"You exceeded your current quota sk-proj-abc","type":"insufficient_quota","code":"insufficient_quota"}}"""

    @Test fun noCreditIsNotCalledRateLimiting() {
        val openai = PhoneProviders.failure(429, quota, kind = "openai")
        assertEquals("This key has no credit. Add billing at platform.openai.com, then try again.", openai)
        assertFalse(openai.contains("sk-proj"))
        assertEquals("This key has no credit left. Add billing with the provider, then try again.", PhoneProviders.failure(429, quota, kind = "openai-compat"))
        assertTrue(PhoneProviders.failure(402, """{"error":{"code":402,"message":"Insufficient credits"}}""").contains("no credit"))
    }

    @Test fun rateLimitsSayHowLongToWait() {
        val limited = """{"error":{"code":"rate_limit_exceeded","message":"Limit reached"}}"""
        assertEquals("Rate limited. Try again in 7s.", PhoneProviders.failure(429, limited, mapOf("Retry-After" to "7")))
        assertEquals("Rate limited. Try again in 1s.", PhoneProviders.failure(429, limited, mapOf("x-ratelimit-reset-requests" to "6m0s", "x-ratelimit-reset-tokens" to "20ms")))
        assertEquals("Rate limited. Try again in 6 min.", PhoneProviders.failure(429, limited, mapOf("x-ratelimit-reset-tokens" to "6m0s")))
        assertEquals("Rate limited. Try again in a moment.", PhoneProviders.failure(429))
        val anthropic = """{"type":"error","error":{"type":"rate_limit_error","message":"too many"}}"""
        assertEquals("Rate limited. Try again in 30s.", PhoneProviders.failure(429, anthropic, mapOf("retry-after" to "30")))
        assertEquals("Rate limited. Try again in a moment.", PhoneProviders.failure(429, """[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}]"""))
    }

    @Test fun modelKeyAndBusyCodes() {
        val model = PhoneProviders.failure(404, """{"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}""")
        assertTrue(model.contains("can’t use that model"))
        assertFalse(model.contains("gpt-9"))
        val key = PhoneProviders.failure(401, """{"error":{"message":"Incorrect API key provided: sk-abc***xyz","code":"invalid_api_key"}}""")
        assertTrue(key.contains("(401)"))
        assertFalse(key.contains("sk-abc"))
        assertTrue(PhoneProviders.failure(529, """{"type":"error","error":{"type":"overloaded_error"}}""").contains("busy"))
        assertEquals("The provider answered 500.", PhoneProviders.failure(500, "not json"))
        // An oversized body is not read.
        assertEquals("Rate limited. Try again in a moment.", PhoneProviders.failure(429, """{"error":{"code":"insufficient_quota","pad":"${"x".repeat(5000)}"}}"""))
    }

    @Test fun durations() {
        assertEquals(1.0, PhoneProviders.duration("1s")!!, 0.0)
        assertEquals(360.0, PhoneProviders.duration("6m0s")!!, 0.0)
        assertEquals(0.02, PhoneProviders.duration("20ms")!!, 1e-9)
        assertEquals(3723.5, PhoneProviders.duration("1h2m3.5s")!!, 1e-9)
        assertNull(PhoneProviders.duration("12"))
        assertNull(PhoneProviders.duration("2026-11-17T08:00:00Z"))
    }

    @Test fun rateLimitHeaders() {
        val openai = PhoneRateLimits.from(mapOf(
            "x-ratelimit-limit-requests" to "500", "x-ratelimit-remaining-requests" to "499", "x-ratelimit-reset-requests" to "120ms",
            "x-ratelimit-limit-tokens" to "30000", "x-ratelimit-remaining-tokens" to "21808", "x-ratelimit-reset-tokens" to "16.38s",
        ), 1_000_000)
        assertEquals(PhoneRateLimits(500, 499, 1_000_120, 30000, 21808, 1_016_380, 1_000_000), openai)
        val anthropic = PhoneRateLimits.from(mapOf(
            "Anthropic-Ratelimit-Requests-Limit" to "50", "anthropic-ratelimit-requests-reset" to "2026-11-17T08:00:01Z",
        ), 5)!!
        assertEquals(50L, anthropic.requestsLimit)
        assertEquals(java.time.Instant.parse("2026-11-17T08:00:01Z").toEpochMilli(), anthropic.requestsResetAt)
        assertNull(PhoneRateLimits.from(mapOf("content-type" to "application/json", "x-ratelimit-remaining-requests" to "-3"), 1))
    }

    @Test fun defaultModelIsTheNewestPlainChatModel() {
        val list = listOf(
            PhoneModel("o3-2025-04-16", "o3-2025-04-16", created = 1_744_000_000), PhoneModel("o3", "o3", created = 1_744_000_000),
            PhoneModel("gpt-live-1", "gpt-live-1", created = 1_790_000_000), PhoneModel("gpt-6.1-terra", "gpt-6.1-terra", created = 1_788_000_000),
            PhoneModel("gpt-6.1-sol", "gpt-6.1-sol", created = 1_788_500_000), PhoneModel("gpt-5.5-pro", "gpt-5.5-pro", created = 1_791_000_000),
        )
        assertEquals("gpt-6.1-sol", PhoneProviders.defaultModel(list)?.id)
        assertEquals("claude-opus-5-5", PhoneProviders.defaultModel(listOf(PhoneModel("claude-x-20250514", "x"), PhoneModel("claude-opus-5-5", "Opus")))?.id)
        assertEquals("o3-2025-04-16", PhoneProviders.defaultModel(listOf(PhoneModel("o3-2025-04-16", "o3")))?.id)
        assertNull(PhoneProviders.defaultModel(emptyList()))
        assertEquals(1_788_500_000L, PhoneProviders.models("""{"data":[{"id":"gpt-6.1-sol","created":1788500000}]}""", "openai").single().created)
    }

    @Test fun openAIKeyCheckIsATinyChatWithTheDefaultModel() {
        val p = PhoneProviders.make("p", "openai", "OpenAI", null, "k")
        assertNull(PhoneProviders.keyCheckRequest(p, "k"))
        val check = PhoneProviders.keyCheckRequest(p, "k", "gpt-6.1-sol")!!
        assertEquals("https://api.openai.com/v1/chat/completions", check.url)
        assertEquals("gpt-6.1-sol", check.body!!["model"].toString().trim('"'))
        assertEquals("16", check.body!!["max_completion_tokens"].toString())
        assertNull(check.body!!["stream"])
        assertEquals("Bearer k", check.headers["Authorization"])
    }
}
