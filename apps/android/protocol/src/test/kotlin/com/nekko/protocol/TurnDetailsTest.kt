package com.nekko.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue

/** #2112: the iPhone's TurnDetailsTests (#1911) on Android. */
class TurnDetailsTest {
    private fun stats(extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): JsonObject = buildJsonObject {
        put("providerId", "anthropic"); put("modelId", "claude-sonnet-5-5")
        put("inputTokens", 1200); put("outputTokens", 480); put("wallMs", 14_200); put("calls", 3)
        extra()
    }
    private fun reply(id: String, stats: JsonObject?, content: String = "Done.", tools: List<String> = emptyList(), interrupted: Boolean = false) =
        ChatMessage(id, "assistant", content, toolCalls = tools.map { ToolCall(it, "bash", JsonObject(emptyMap())) }, interrupted = interrupted, turnStats = TurnStats.from(stats))

    @Test fun `the schema projection keeps counts and ids, drops unknown meanings`() {
        val s = TurnStats.from(stats { put("effort", "xhigh"); put("stop", "complete"); put("outputMs", 6000); put("cacheReadTokens", 800); put("apiKey", "sk-secret") })!!
        assertEquals("xhigh", s.effort)
        assertEquals("complete", s.stop)
        assertEquals(setOf("providerId", "modelId", "inputTokens", "outputTokens", "wallMs", "calls", "effort", "stop", "outputMs", "cacheReadTokens"), s.json().keys)
        assertNull(TurnStats.from(stats { put("effort", "ludicrous"); put("stop", "tired") })!!.effort)
        assertNull(TurnStats.from(stats { put("stop", "tired") })!!.stop)
    }

    @Test fun `a malformed required field drops the stats, a malformed optional one is ignored`() {
        assertNull(TurnStats.from(buildJsonObject { put("providerId", "a"); put("modelId", "m"); put("inputTokens", 1); put("outputTokens", 1); put("wallMs", 1) }))
        assertNull(TurnStats.from(stats { put("inputTokens", -1) }))
        assertNull(TurnStats.from(stats { put("modelId", "") }))
        assertNull(TurnStats.from(stats { put("wallMs", "fast") }))
        assertNull(TurnStats.from(stats { put("cacheReadTokens", -5) })!!.cacheReadTokens)
        assertNull(TurnStats.from(null))
    }

    @Test fun `input counts the cache it read and wrote`() {
        assertEquals(1200.0 + 800 + 50, TurnStats.from(stats { put("cacheReadTokens", 800); put("cacheWriteTokens", 50) })!!.allInput, 1e-9)
    }

    @Test fun `speed needs at least 100 ms of decode time and never uses wall time`() {
        assertNull(TurnStats.from(stats { put("outputMs", 99) })!!.tokensPerSecond)
        assertEquals(4800.0, TurnStats.from(stats { put("outputMs", 100) })!!.tokensPerSecond!!, 1e-9)
        assertNull(TurnStats.from(stats())!!.tokensPerSecond)
        assertNull(TurnStats.from(stats { put("outputMs", 5000); put("outputTokens", 0) })!!.tokensPerSecond)
    }

    @Test fun `the check only for a recorded complete stop that was not interrupted`() {
        assertTrue(TurnDetails.of(reply("a", stats { put("stop", "complete") }))!!.successful)
        assertFalse(TurnDetails.of(reply("a", stats { put("stop", "complete") }, interrupted = true))!!.successful)
        assertFalse(TurnDetails.of(reply("a", stats { put("stop", "loop") }))!!.successful)
        assertFalse(TurnDetails.of(reply("a", stats()))!!.successful)
        assertNull(TurnDetails.of(reply("a", null)))
        assertNull(TurnDetails.of(ChatMessage("u", "user", "hi", turnStats = TurnStats.from(stats()))))
    }

    @Test fun `footers anchor after the last tool, the reply, or the block before an empty one`() {
        val user = ChatMessage("u1", "user", "Fix it")
        val f = TurnDetails.footers(listOf(
            user,
            reply("r1", stats(), content = "Looking.", tools = listOf("t1", "t2")),
            reply("r2", stats { put("stop", "complete") }, content = "Fixed."),
            ChatMessage("u2", "user", "Again"),
            reply("r3", stats(), content = "", tools = listOf("t3")),
            ChatMessage("u3", "user", "And?"),
            reply("r4", stats(), content = ""),
            reply("r5", null, content = "No stats."),
        ))
        assertEquals(setOf("t2", "r2", "t3", "u3"), f.keys)
        assertEquals("r4", f.getValue("u3").id)
    }

    @Test fun `saved copies keep the stats and read them back`() {
        val m = reply("r", stats { put("stop", "complete"); put("outputMs", 2000) })
        val back = ChatMessage.from(m.savedJson())!!
        assertEquals(m.turnStats, back.turnStats)
        assertNull(ChatMessage.from(reply("r", null).savedJson())!!.turnStats)
    }

    @Test fun `tokens and rates read short`() {
        assertEquals("812", TurnDetails.tokens(812.0))
        assertEquals("1.2k", TurnDetails.tokens(1234.0))
        assertEquals("34k", TurnDetails.tokens(34_400.0))
        assertEquals("48", TurnDetails.rate(48.4))
        assertEquals("7.5", TurnDetails.rate(7.46))
    }
}
