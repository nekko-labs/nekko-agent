package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** The same cases as `canOfferSubagent` and `inSubagent` in orchestration.test.ts (the iPhone's ModelEffortTests). */
class SubagentChoiceTest {
    private val reply = """{"id":"s","title":"T","messages":[{"id":"a","role":"assistant","content":"Done"}]}"""

    private fun chat(extra: String = "", messages: String? = null): Session {
        val body = messages?.let { reply.replaceAfter("\"messages\":", "$it}") } ?: reply
        return Session.from(Json.parseToJsonElement(if (extra.isEmpty()) body else body.dropLast(1) + ",$extra}"))!!
    }

    @Test fun `offers once the chat has a reply to follow up on`() {
        assertTrue(chat().canOfferSubagent("balanced"))
        assertTrue(chat().canOfferSubagent(null))
        assertFalse(chat(messages = """[{"id":"u","role":"user","content":"Hi"}]""").canOfferSubagent(null))
    }

    @Test fun `stays away wherever delegation cannot run`() {
        assertFalse(chat().canOfferSubagent("solo"))
        for (extra in listOf(""""parentSessionId":"p"""", """"incognito":true""", """"offline":true""", """"executionMode":"sandbox"""",
            """"disabledTools":["spawn_agent"]""", """"chatType":"image"""")) {
            assertFalse(extra, chat(extra).canOfferSubagent(null))
        }
    }

    @Test fun `reads the computer's strategy`() {
        assertEquals("solo", PcSettings.from(Json.parseToJsonElement("""{"orchestration":{"strategy":"solo"}}""")).orchestrationStrategy)
        assertEquals(null, PcSettings.from(Json.parseToJsonElement("{}")).orchestrationStrategy)
    }

    @Test fun `keeps the message whole and says what was asked`() {
        assertEquals("Do this in a subagent, then report back:\n\nFix the tests", Session.inSubagent("Fix the tests"))
    }
}

/** T201a: the same cases as `modelEffortLevels` in model-capabilities.test.ts (the iPhone's ModelEffortTests), and the levels the computer's gate takes. */
class ModelEffortTest {
    @Test fun `offers each model its own ladder`() {
        val claude = listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
        assertEquals(claude, Effort.levels("claude-opus-5-5"))
        assertEquals(claude, Effort.levels("claude-fable-5-1"))
        assertEquals(claude, Effort.levels("claude-haiku-5-5"))
        assertEquals(claude, Effort.levels("us.anthropic.claude-opus-4-7"))
        assertEquals(claude, Effort.levels("anthropic/claude-sonnet-5"))
        assertFalse(Effort.usesNativeEffort("claude-sonnet-4-6"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels("claude-haiku-4-5"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels("claude-opus-4-20250514"))
        assertEquals(listOf(Effort.LOW, Effort.MEDIUM, Effort.NORMAL, Effort.HIGH), Effort.levels("gpt-5"))
        assertEquals(listOf(Effort.LOW, Effort.MEDIUM, Effort.NORMAL, Effort.HIGH), Effort.levels("openai/gpt-6-sol"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels("qwen3-8b"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels(null))
    }

    @Test fun `every level offered is one the computer takes from a phone`() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/src/phone-access.json")
        assumeTrue("running outside the monorepo", f.exists())
        val levels = Json.parseToJsonElement(f.readText()).jsonObject["effortLevels"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(levels, Effort.entries.map { it.wire })
        assertEquals(Effort.XHIGH, Effort.parse("xhigh"))
    }

    @Test fun `local providers are the on-device servers`() {
        for (k in listOf("llamacpp", "ollama", "lmstudio", "vllm")) assertTrue(k, LocalProviders.isLocal(k))
        for (k in listOf("anthropic", "openai", "openai-compat", "openrouter", null)) assertFalse("$k", LocalProviders.isLocal(k))
    }
}
