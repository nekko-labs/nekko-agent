package com.nekko.protocol

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PhoneProvidersTest {
    private fun provider(kind: String) = PhoneProviders.make("p", kind, "API", "https://api.example.com/base", "secret")
    private fun rejected(block: () -> Unit) {
        try { block(); fail("Expected validation failure") } catch (_: IllegalArgumentException) { }
    }
    private fun frame(parser: PhoneStreamParser, json: String): List<PhoneStreamEvent> {
        parser.line("data: $json")
        return parser.line("")
    }
    @Test fun sevenKindsAndCorrectAuthentication() {
        assertEquals(listOf("anthropic", "openai", "openrouter", "bedrock", "foundry", "vertex", "openai-compat"), PhoneProviders.kinds.map { it.id })
        for (kind in PhoneProviders.kinds) {
            val req = PhoneProviders.chatRequest(provider(kind.id), " secret ", "model", emptyList())
            if (kind.id in listOf("anthropic", "bedrock", "foundry")) { assertEquals("secret", req.headers["x-api-key"]); assertNull(req.headers["Authorization"]) }
            else { assertEquals("Bearer secret", req.headers["Authorization"]); assertNull(req.headers["x-api-key"]) }
            assertFalse(req.body!!.containsKey("tools"))
            assertEquals("text/event-stream", req.headers["Accept"])
            if (kind.id == "vertex") assertNull(req.headers["anthropic-version"])
        }
    }
    @Test fun mantleUsesMessagesRouteAndOnlyMantleModels() {
        val p = PhoneProviders.make("p", "bedrock", "AWS", null, "token")
        val req = PhoneProviders.chatRequest(p, "token", "anthropic.claude-opus-5-5", emptyList())
        assertEquals("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages", req.url)
        assertEquals("token", req.headers["x-api-key"])
        assertEquals("2023-06-01", req.headers["anthropic-version"])
        assertNull(req.headers["Authorization"])
        assertFalse(PhoneProviders.kind("bedrock")!!.catalog.any { it.id == "anthropic.claude-sonnet-4-6" })
    }
    @Test fun rejectsUnsafeAddressesAndAllowsOptionalCompatibleKey() {
        for (url in listOf("http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com?key=x", "https://api.example.com#frag", "https://YOUR_RESOURCE.example.com", "https://", "https://example.com:0", "https://example.com:65536", "https://example.com/a/../b", "https://example.com/%2e%2e/b", "https://example.com/%0a", "https://example.com/a\\b")) {
            rejected { PhoneProviders.make("p", "openai", "API", url, "key") }
        }
        PhoneProviders.make("p", "openai-compat", "API", "https://example.com:8443/v1", null)
        rejected { PhoneProviders.make("p", "openai", "API", null, "") }
    }
    @Test fun persistedMetadataAndHeaderValuesAreRevalidated() {
        for (p in listOf(provider("openai").copy(baseUrl = "http://example.com"), provider("openai").copy(kind = "unknown"), provider("openai").copy(enabled = false), provider("openai").copy(baseUrl = " https://example.com"))) {
            rejected { PhoneProviders.chatRequest(p, "secret", "model", emptyList()) }
            rejected { PhoneProviders.modelsRequest(p, "secret") }
        }
        for (key in listOf("secret\r\nx-api-key: bad", "secret\u0000", "secret\t", "secret\u007f", "secreté")) {
            rejected { PhoneProviders.chatRequest(provider("openai"), key, "model", emptyList()) }
        }
        rejected { PhoneProviders.modelsRequest(provider("anthropic").copy(workspaceId = "w\r\nBad"), "key") }
    }
    @Test fun pathsBodiesAndOpenRouterModelIds() {
        val messages = listOf(PhoneMessage("m", "user", "Hello", 0), PhoneMessage("x", "system", "untrusted", 0), PhoneMessage("a", "assistant", " ", 0))
        val v = PhoneProviders.chatRequest(provider("vertex"), "key", "claude@2025", messages)
        assertTrue(v.url.endsWith("/publishers/anthropic/models/claude@2025:streamRawPredict"))
        assertFalse(v.body!!.containsKey("model"))
        assertEquals("vertex-2023-10-16", v.body["anthropic_version"]!!.jsonPrimitive.content)
        val router = PhoneProviders.chatRequest(provider("openrouter"), "key", "maker/model", messages, maxTokens = 99)
        assertEquals("maker/model", router.body!!["model"]!!.jsonPrimitive.content)
        assertEquals(2, router.body["messages"]!!.jsonArray.size)
        assertEquals(99, router.body["max_tokens"]!!.jsonPrimitive.int)
        val openai = PhoneProviders.chatRequest(provider("openai"), "key", "model", messages, maxTokens = 99)
        assertEquals(99, openai.body!!["max_completion_tokens"]!!.jsonPrimitive.int)
        assertFalse(openai.body.containsKey("max_tokens"))
        assertNotNull(PhoneProviders.modelsRequest(provider("anthropic"), "key"))
        assertNull(PhoneProviders.modelsRequest(provider("bedrock"), "key"))
        for (model in listOf("../evil", "a/b", "a:streamRawPredict", ".", "x?key=y", "x#z")) {
            rejected { PhoneProviders.chatRequest(provider("vertex"), "key", model, messages) }
        }
        rejected { PhoneProviders.chatRequest(provider("openai"), "key", "model", messages, maxTokens = 0) }
        val trailing = PhoneProviders.chatRequest(provider("openai").copy(baseUrl = "https://example.com/v1/"), "key", "model", messages)
        assertEquals("https://example.com/v1/chat/completions", trailing.url)
    }
    @Test fun parsesModelListsAndDoesNotEchoProviderErrors() {
        val body = """{"data":[null,4,{"id":9},{"id":"gpt-chat"},{"id":"tts-1"},{"id":"gpt-chat"}]}"""
        assertEquals(listOf("gpt-chat"), PhoneProviders.models(body, "openai").map { it.id })
        assertTrue(PhoneProviders.models("[]", "openai").isEmpty())
        assertFalse(PhoneProviders.failure(401, "secret-key").contains("secret-key"))
    }
    @Test fun streamsAnthropicOpenaiAndMultilineFrames() {
        val a = PhoneStreamParser()
        assertTrue(a.line("event: content_block_delta").isEmpty())
        assertEquals(listOf(PhoneStreamEvent.Text("Hello")), frame(a, """{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}"""))
        assertEquals(listOf(PhoneStreamEvent.Done), frame(a, """{"type":"message_stop"}"""))
        val o = PhoneStreamParser()
        o.line("data: {\"choices\":["); o.line("data: {\"delta\":{\"content\":\"Hi\"}}]}")
        assertEquals(listOf(PhoneStreamEvent.Text("Hi")), o.line(""))
        assertEquals(listOf(PhoneStreamEvent.Done), frame(o, "[DONE]"))
        assertTrue(frame(o, "not JSON").isEmpty())
    }
    @Test fun finishReasonIsNotStreamCompletionAndLaterErrorsSurvive() {
        val p = PhoneStreamParser()
        assertTrue(frame(p, """{"choices":[{"delta":{},"finish_reason":"stop"}]}""").isEmpty())
        assertTrue(frame(p, """{"choices":[],"usage":{"completion_tokens":2}}""").isEmpty())
        assertTrue(frame(p, """{"error":{"message":"secret"}}""").single() is PhoneStreamEvent.Failure)
        assertTrue(frame(p, "[DONE]").isEmpty())
    }
    @Test fun errorsAndMalformedStreamsAreTerminalSanitizedFailures() {
        for (json in listOf("""{"error":{"message":"secret"}}""", "not JSON", "[]", "null", """{"choices":{}}""", """{"choices":[false]}""", """{"choices":[{"delta":[]}]}""", """{"type":"content_block_delta","delta":false}""")) {
            val p = PhoneStreamParser()
            val event = frame(p, json).single() as PhoneStreamEvent.Failure
            assertFalse(event.message.contains("secret"))
            assertTrue(frame(p, "[DONE]").isEmpty())
        }
        val p = PhoneStreamParser(); p.line("event: error")
        assertTrue(p.line("").single() is PhoneStreamEvent.Failure)
    }
    @Test fun boundsLinesFramesStreamAndReplyAcrossManyEvents() {
        val oversized = PhoneStreamParser()
        assertTrue(oversized.line("data: " + "x".repeat(PhoneStreamParser.MAX_FRAME_CHARS)).single() is PhoneStreamEvent.Failure)
        val multiline = PhoneStreamParser()
        repeat(9) { assertTrue(multiline.line("data: " + "x".repeat(100_000)).isEmpty()) }
        assertTrue(multiline.line("data: " + "x".repeat(100_000)).single() is PhoneStreamEvent.Failure)
        val stream = PhoneStreamParser()
        var failure = false
        repeat(90) {
            if (stream.line(":" + "x".repeat(100_000)).any { it is PhoneStreamEvent.Failure }) failure = true
            stream.line("")
        }
        assertTrue(failure)
        val reply = PhoneStreamParser()
        val chunk = """{"choices":[{"delta":{"content":"${"x".repeat(500_000)}"}}]}"""
        repeat(4) { assertTrue(frame(reply, chunk).single() is PhoneStreamEvent.Text) }
        assertTrue(frame(reply, chunk).single() is PhoneStreamEvent.Failure)
    }
    @Test fun ignoresThinkingAndAlternativeCompletions() {
        val p = PhoneStreamParser()
        assertTrue(frame(p, """{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private"}}""").isEmpty())
        assertEquals(listOf(PhoneStreamEvent.Text("first")), frame(p, """{"choices":[{"delta":{"content":"first"}},{"delta":{"content":"alternative"}}]}"""))
        p.line("data: [DONE]")
        // A final data line without its blank frame delimiter has not completed.
        assertTrue(p.line(": keepalive").isEmpty())
    }
}
