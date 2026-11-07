package com.nekko.protocol

import org.junit.Assert.*
import org.junit.Test

class QuestionRepliesTest {
    private val body = "Q: Which scope?\nA: App — Keep **this**\nexact note\n\nQ: Which tests?\nA: (not answered)"
    private val output = "The user answered:\n\n$body\n\nWork to these answers. Do not ask again about anything settled here."
    private val call = ToolCall("ask", "ask_user", kotlinx.serialization.json.JsonObject(emptyMap()))

    @Test fun `shows a literal reply both live and after reopening without a duplicate prompt`() {
        val prompt = ChatMessage("p", "user", "Start")
        val saved = Transcript.fromMessages(listOf(prompt, ChatMessage("a", "assistant", "", toolCalls = listOf(call)), ChatMessage("r", "tool", "", toolResult = ToolResult("ask", output, false))))
        var live = LiveTurn(blocks = listOf(Block.User("p", "Start")))
        live = Transcript.apply(live, AgentEvent.ToolCallStarted("s", call))
        live = Transcript.apply(live, AgentEvent.ToolResultReady("s", ToolResult("ask", output, false)))
        for (blocks in listOf(Transcript.mergeLive(emptyList(), live.blocks), Transcript.mergeLive(saved, live.blocks), Transcript.mergeLive(saved, emptyList()))) {
            val replies = QuestionReplies.project(blocks).filterIsInstance<Block.User>().filter { it.id.startsWith("ask-answer:") }
            assertEquals(1, replies.size)
            assertEquals(body, replies.single().text)
        }
        assertEquals(1, saved.filterIsInstance<Block.User>().size)
    }

    @Test fun `does not project failed pending unrelated malformed or orphaned results`() {
        assertNull(QuestionReplies.body("bash", output))
        assertNull(QuestionReplies.body("ask_user", "The user answered:\n\nincomplete"))
        assertEquals(1, QuestionReplies.project(listOf(Block.Tool("a", "ask_user", "Ask", ToolStatus.ERROR, output))).size)
        assertEquals(1, QuestionReplies.project(listOf(Block.Tool("a", "ask_user", "Ask", ToolStatus.RUNNING))).size)
        assertTrue(QuestionReplies.project(Transcript.fromMessages(listOf(ChatMessage("r", "tool", "", toolResult = ToolResult("ask", output, false))))).isEmpty())
    }

    @Test fun `long answers survive ordinary tool output clipping`() {
        val long = output.replace("Keep **this**", "x".repeat(5000))
        val saved = Transcript.fromMessages(listOf(ChatMessage("a", "assistant", "", toolCalls = listOf(call)), ChatMessage("r", "tool", "", toolResult = ToolResult("ask", long, false))))
        assertTrue(QuestionReplies.project(saved).filterIsInstance<Block.User>().single().text.contains("x".repeat(5000)))
    }
}
