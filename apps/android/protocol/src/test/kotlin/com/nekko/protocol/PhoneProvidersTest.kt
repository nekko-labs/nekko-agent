package com.nekko.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PhoneProvidersTest {
    private fun provider(kind: String) = PhoneProviders.make("p", kind, "API", "https://api.example.com/base", "secret")
    @Test fun sevenKindsAndCorrectAuthentication() {
        assertEquals(listOf("anthropic", "openai", "openrouter", "bedrock", "foundry", "vertex", "openai-compat"), PhoneProviders.kinds.map { it.id })
        for (kind in PhoneProviders.kinds) {
            val req = PhoneProviders.chatRequest(provider(kind.id), "secret", "model", emptyList())
            if (kind.id in listOf("anthropic", "foundry")) { assertEquals("secret", req.headers["x-api-key"]); assertNull(req.headers["Authorization"]) }
            else { assertEquals("Bearer secret", req.headers["Authorization"]); assertNull(req.headers["x-api-key"]) }
            assertFalse(req.body!!.containsKey("tools"))
        }
    }
    @Test fun rejectsUnsafeAddressesAndAllowsOptionalCompatibleKey() {
        for (url in listOf("http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com?key=x", "https://api.example.com#frag", "https://YOUR_RESOURCE.example.com", "https://")) {
            try { PhoneProviders.make("p", "openai", "API", url, "key"); fail(url) } catch (_: IllegalArgumentException) { }
        }
        PhoneProviders.make("p", "openai-compat", "API", "https://example.com", null)
        try { PhoneProviders.make("p", "openai", "API", null, ""); fail() } catch (_: IllegalArgumentException) { }
    }
    @Test fun pathsBodiesAndOpenRouterModelIds() {
        val messages = listOf(PhoneMessage("m", "user", "Hello", 0))
        val v = PhoneProviders.chatRequest(provider("vertex"), "key", "claude@2025", messages)
        assertTrue(v.url.endsWith("/publishers/anthropic/models/claude@2025:streamRawPredict"))
        assertFalse(v.body!!.containsKey("model"))
        assertEquals("vertex-2023-10-16", v.body["anthropic_version"]!!.jsonPrimitive.content)
        val router = PhoneProviders.chatRequest(provider("openrouter"), "key", "maker/model", messages)
        assertEquals("maker/model", router.body!!["model"]!!.jsonPrimitive.content)
        assertEquals(2, router.body["messages"]!!.jsonArray.size)
        assertNotNull(PhoneProviders.modelsRequest(provider("anthropic"), "key"))
        assertNull(PhoneProviders.modelsRequest(provider("bedrock"), "key"))
    }
    @Test fun parsesModelListsAndDoesNotEchoProviderErrors() {
        val body = """{"data":[{"id":"gpt-chat"},{"id":"tts-1"}]}"""
        assertEquals(listOf("gpt-chat"), PhoneProviders.models(body, "openai").map { it.id })
        assertFalse(PhoneProviders.failure(401, "secret-key").contains("secret-key"))
    }
    @Test fun streamsAnthropicOpenaiAndMultilineFrames() {
        val a = PhoneStreamParser()
        assertTrue(a.line("event: content_block_delta").isEmpty())
        a.line("data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hello\"}}")
        assertEquals(listOf(PhoneStreamEvent.Text("Hello")), a.line(""))
        a.line("data: {\"type\":\"message_stop\"}")
        assertEquals(listOf(PhoneStreamEvent.Done), a.line(""))
        val o = PhoneStreamParser()
        o.line("data: {\"choices\":["); o.line("data: {\"delta\":{\"content\":\"Hi\"}}]}")
        assertEquals(listOf(PhoneStreamEvent.Text("Hi")), o.line(""))
        o.line("data: [DONE]")
        assertEquals(listOf(PhoneStreamEvent.Done), o.line(""))
        assertTrue(o.line("").isEmpty())
    }
    @Test fun errorsAndMalformedStreamsAreFailures() {
        for (frame in listOf("{\"error\":{\"message\":\"secret\"}}", "not JSON")) {
            val p = PhoneStreamParser(); p.line("data: $frame")
            val event = p.line("").single() as PhoneStreamEvent.Failure
            assertFalse(event.message.contains("secret"))
        }
    }
}
