package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A chat row's model, context and PR chip, held to the iPhone's ChatCardTests (and so the desktop's agent card). */
class ChatCardTest {
    private fun chat(json: String) = SessionSummary.from(Json.parseToJsonElement(json))!!
    private fun prs(json: String) = PullRequest.list(Json.parseToJsonElement(json))

    @Test fun `names Claude models as the desktop card does`() {
        assertEquals("Opus 5.5", ChatCard.modelName("claude-opus-5-5"))
        assertEquals("Sonnet 4.5", ChatCard.modelName("claude-sonnet-4-5-20250929"))
        assertEquals("Haiku 5", ChatCard.modelName("anthropic/claude-haiku-5"))
        assertEquals("Opus 4.7", ChatCard.modelName("us.anthropic.claude-opus-4-7"))
        assertEquals("Fable 5.1", ChatCard.modelName("claude-fable-5-1"))
        assertEquals("qwen3-coder", ChatCard.modelName("qwen/qwen3-coder:latest"))
        assertEquals("gpt-5", ChatCard.modelName("gpt-5"))
    }

    @Test fun `picks the provider mark from the kind then the model`() {
        assertEquals("anthropic", ChatCard.providerMark("claude-code", "opus"))
        assertEquals("anthropic", ChatCard.providerMark("bedrock", "anthropic.claude-opus-4-7"))
        assertEquals("openai", ChatCard.providerMark("chatgpt", "gpt-5"))
        assertEquals("google", ChatCard.providerMark("gemini", null))
        assertEquals("ollama", ChatCard.providerMark("ollama-cloud", null))
        assertEquals("openrouter", ChatCard.providerMark("openrouter", "anthropic/claude-opus-5-5"))
        assertNull("a custom endpoint has no mark", ChatCard.providerMark("openai-compat", "claude-opus-5-5"))
        assertNull(ChatCard.providerMark("llamacpp", "qwen3"))
        assertEquals("anthropic", ChatCard.providerMark(null, "claude-sonnet-5-5"))
        assertEquals("openai", ChatCard.providerMark(null, "gpt-5.6-sol"))
        assertEquals("openai", ChatCard.providerMark(null, "o3"))
        assertEquals("google", ChatCard.providerMark("", "gemini-3-pro"))
        assertNull("a gateway id says nothing of the provider", ChatCard.providerMark(null, "anthropic/claude-opus-5-5"))
        assertNull(ChatCard.providerMark(null, "qwen3-coder"))
        assertNull(ChatCard.providerMark(null, null))
    }

    @Test fun `guesses the window and tone as the desktop`() {
        assertEquals(1_000_000L, ChatCard.guessContextWindow("claude-opus-5-5"))
        assertEquals(200_000L, ChatCard.guessContextWindow("claude-sonnet-4-5"))
        assertEquals(200_000L, ChatCard.guessContextWindow("claude-haiku-4-5"))
        assertEquals(1_000_000L, ChatCard.guessContextWindow("opus"))
        assertEquals(400_000L, ChatCard.guessContextWindow("gpt-5"))
        assertEquals(272_000L, ChatCard.guessContextWindow("gpt-5.6-terra"))
        assertEquals(200_000L, ChatCard.guessContextWindow("o3"))
        assertEquals(128_000L, ChatCard.guessContextWindow("qwen3"))
        assertEquals(ChatCard.Fill.ROOM, ChatCard.fill(59, 100))
        assertEquals(ChatCard.Fill.FILLING, ChatCard.fill(60, 100))
        assertEquals(ChatCard.Fill.FULL, ChatCard.fill(85, 100))
        assertEquals("950", ChatCard.compactTokens(950))
        assertEquals("4.5k", ChatCard.compactTokens(4_500))
        assertEquals("312k", ChatCard.compactTokens(312_400))
        assertEquals("1M", ChatCard.compactTokens(1_000_000))
        assertEquals("1M", ChatCard.compactTokens(1_047_576))
    }

    @Test fun `shows context only while the chat is in progress`() {
        val used = chat("""{"id":"s","title":"t","updatedAt":1,"modelId":"claude-opus-5-5","transcriptTokens":45000}""")
        assertEquals("45k/1M", ChatCard.context(used)?.text)
        assertEquals(ChatCard.Fill.ROOM, ChatCard.context(used)?.fill)
        assertTrue(ChatCard.showsContext(used, Activity.RUNNING))
        assertTrue(ChatCard.showsContext(used, Activity.NEEDS_YOU))
        assertFalse("a finished reply has no context pressure", ChatCard.showsContext(used, null))
        assertTrue(ChatCard.showsContext(chat("""{"id":"s","title":"t","updatedAt":1,"activeWatchCount":1}"""), null))
        assertFalse(ChatCard.showsContext(chat("""{"id":"s","title":"t","updatedAt":1,"archivedAt":5}"""), Activity.RUNNING))
        val reported = chat("""{"id":"s","title":"t","updatedAt":1,"modelId":"opus","claudeCodeContext":{"modelId":"opus","used":180000,"window":200000}}""")
        assertEquals("180k/200k", ChatCard.context(reported)?.text)
        assertEquals(ChatCard.Fill.FULL, ChatCard.context(reported)?.fill)
        assertNull(ChatCard.context(chat("""{"id":"s","title":"t","updatedAt":1}""")))
    }

    @Test fun `the PR chip leads with the PR still in flight`() {
        val list = prs(
            """[{"url":"https://github.com/o/r/pull/3","number":3,"state":"merged"},
                {"url":"https://github.com/o/r/pull/5","number":5,"state":"open","isDraft":true},
                {"url":"https://github.com/o/r/pull/4","number":4,"state":"closed"}]""",
        )
        assertEquals(5, ChatCard.primaryPr(list)?.number)
        assertEquals(ChatCard.PrStatus.DRAFT, ChatCard.prStatus(ChatCard.primaryPr(list)!!))
        val open = prs(
            """[{"url":"https://github.com/o/r/pull/7","number":7,"state":"open"},
                {"url":"https://github.com/o/r/pull/9","number":9,"state":"open"},
                {"url":"https://github.com/o/other/pull/12","number":12,"state":"open"}]""",
        )
        assertEquals("the newest in the same repository", 9, ChatCard.primaryPr(open)?.number)
        assertNull(ChatCard.primaryPr(emptyList()))
    }
}
