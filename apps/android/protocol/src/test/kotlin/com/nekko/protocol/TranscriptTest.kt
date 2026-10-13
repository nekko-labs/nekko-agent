package com.nekko.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors apps/mobile/src/lib/transcript.test.ts. */
class TranscriptTest {
    private fun call(id: String, name: String = "bash", vararg kv: Pair<String, String>) =
        ToolCall(id, name, JsonObject(kv.associate { it.first to JsonPrimitive(it.second) }))

    @Test fun `saved messages attach tool results to their calls`() {
        val blocks = Transcript.fromMessages(listOf(
            ChatMessage("u", "user", "list files"),
            ChatMessage("a", "assistant", "Sure", toolCalls = listOf(call("c1", "bash", "command" to "ls -la"))),
            ChatMessage("t", "tool", "", toolResult = ToolResult("c1", "a\nb", isError = true)),
            ChatMessage("a2", "assistant", "  "),
            ChatMessage("u2", "user", "", skill = "review" to "this"),
        ))
        assertEquals(4, blocks.size)
        val tool = blocks[2] as Block.Tool
        assertEquals("Run ls -la", tool.label)
        assertEquals(ToolStatus.ERROR, tool.status)
        assertEquals("/review this", (blocks[3] as Block.User).text)
    }

    @Test fun `streams text, runs a tool through approval, and settles on done`() {
        var t = LiveTurn(running = true, blocks = listOf(Block.User("p", "go")))
        t = Transcript.apply(t, AgentEvent.Reasoning("s", "think"))
        t = Transcript.apply(t, AgentEvent.Text("s", "Hel"))
        t = Transcript.apply(t, AgentEvent.Text("s", "lo"))
        val a = t.blocks[1] as Block.Assistant
        assertEquals("Hello", a.text); assertEquals("think", a.reasoning); assertTrue(a.streaming)

        val c = call("c1", "write_file", "path" to "/tmp/x")
        t = Transcript.apply(t, AgentEvent.ToolCallStarted("s", c))
        assertFalse((t.blocks[1] as Block.Assistant).streaming)
        t = Transcript.apply(t, AgentEvent.ApprovalRequired("s", Approval(c, "writes", Severity.MEDIUM)))
        assertEquals(ToolStatus.WAITING, (t.blocks[2] as Block.Tool).status)
        assertEquals("c1", t.approval!!.call.id)
        t = Transcript.apply(t, AgentEvent.ToolResultReady("s", ToolResult("c1", "ok", false)))
        assertNull(t.approval)
        assertEquals(ToolStatus.OK, (t.blocks[2] as Block.Tool).status)

        t = Transcript.apply(t, AgentEvent.Usage("s", 100, 2000))
        assertEquals(50.0, t.rate!!, 0.001)
        t = Transcript.apply(t, AgentEvent.Done("s", "m"))
        assertFalse(t.running)
    }

    @Test fun `a user stop is not an error, a failure is`() {
        assertNull(Transcript.apply(LiveTurn(running = true), AgentEvent.Error("s", "Stopped")).error)
        assertEquals("boom", Transcript.apply(LiveTurn(running = true), AgentEvent.Error("s", "boom")).error)
    }

    @Test fun `questions open and resolve by call id`() {
        val q = AskRequest("q1", emptyList(), 0)
        var t = Transcript.apply(LiveTurn(), AgentEvent.Question("s", q))
        assertEquals(q, t.question)
        t = Transcript.apply(t, AgentEvent.QuestionResolved("s", "other"))
        assertEquals(q, t.question)
        t = Transcript.apply(t, AgentEvent.QuestionResolved("s", "q1"))
        assertNull(t.question)
    }

    @Test fun `retry drops text streamed since the last tool`() {
        var t = LiveTurn(running = true, blocks = listOf(Block.User("p", "go")))
        t = Transcript.apply(t, AgentEvent.ToolCallStarted("s", call("c1")))
        t = Transcript.apply(t, AgentEvent.Text("s", "half a rep"))
        t = Transcript.apply(t, AgentEvent.Retry("s"))
        assertEquals(2, t.blocks.size)
        assertTrue(t.blocks.last() is Block.Tool)
    }

    @Test fun `merge appends the overlay when the prompt is not saved yet`() {
        val saved = listOf(Block.User("u1", "old"), Block.Assistant("a1", "old reply"))
        val live = listOf(Block.User("p", "new"), Block.Assistant("l", "streaming", streaming = true))
        assertEquals(saved + live, Transcript.mergeLive(saved, live))
    }

    @Test fun `merge hides what the re-read session already holds`() {
        val saved = listOf(
            Block.User("u1", "same"), Block.Assistant("a0", "Done."),
            Block.User("u2", "go"), Block.Assistant("a1", "Done."), Block.Tool("c1", "bash", "Run ls", ToolStatus.OK),
        )
        val live = listOf(
            Block.User("p", "go"), Block.Assistant("l0", "Done."),
            Block.Tool("c1", "bash", "Run ls", ToolStatus.WAITING), Block.Assistant("l1", "More", streaming = true),
        )
        val merged = Transcript.mergeLive(saved, live)
        assertEquals(listOf("u1", "a0", "u2", "a1", "c1", "l1"), merged.map { it.id })
        assertEquals(ToolStatus.WAITING, (merged[4] as Block.Tool).status)
    }

    @Test fun `activity follows the event stream`() {
        var a = emptyMap<String, Activity>()
        a = ActivityTracker.next(a, AgentEvent.Text("s", "x"))
        assertEquals(Activity.RUNNING, a["s"])
        a = ActivityTracker.next(a, AgentEvent.Question("s", AskRequest("q", emptyList(), 0)))
        assertEquals(Activity.NEEDS_YOU, a["s"])
        val same = ActivityTracker.next(a, AgentEvent.Other("s", "compaction"))
        assertTrue(same === a)
        a = ActivityTracker.next(a, AgentEvent.Done("s", null))
        assertTrue(a.isEmpty())
    }

    @Test fun `long tool output is clipped`() {
        val c = Transcript.clip("x".repeat(4010))
        assertTrue(c.endsWith("(10 more characters)"))
    }
}
