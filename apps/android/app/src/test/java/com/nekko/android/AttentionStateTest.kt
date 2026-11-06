package com.nekko.android

import com.nekko.android.connection.AttentionNotices
import com.nekko.android.data.AttentionState
import com.nekko.android.data.ComputersState
import com.nekko.protocol.*
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class AttentionStateTest {
    private fun summary(id: String, title: String = "") = SessionSummary(id, title, 0, null, null, null, false, null, null, null)
    private val approval = Approval(ToolCall("tool-1", "bash", JsonObject(emptyMap())), "Run a command", Severity.MEDIUM)
    private val question = AskRequest("ask-1", emptyList(), 0)
    private fun waiting() = AttentionState()
        .next(AgentEvent.ApprovalRequired("a", approval))
        .next(AgentEvent.Question("a", question))
        .next(AgentEvent.Question("b", question))
    private fun AttentionState.read(snapshot: Map<String, PendingInput>?) = beginSnapshot().let { it.reconcile(snapshot, it.version) }

    @Test fun `distinct chats not repeated events or inputs determine badge units`() {
        val waiting = waiting().next(AgentEvent.ApprovalRequired("a", approval))
        val state = ComputersState(attention = waiting, summaries = listOf(summary("a"), summary("b")))
        assertEquals(setOf("a", "b"), AttentionNotices.of(state, true, false).map { it.sessionId }.toSet())
        assertEquals(2, AttentionNotices.of(state, true, false).size)
        assertTrue(AttentionNotices.of(state, false, false).isEmpty())
        assertEquals(1, AttentionNotices.of(state.copy(summaries = listOf(summary("a"))), true, false).size)
        assertTrue(AttentionNotices.of(state.copy(summaries = emptyList()), true, false).isEmpty())
    }

    @Test fun `viewing and streaming never resolve attention`() {
        val waiting = waiting()
        assertSame(waiting, waiting.next(AgentEvent.Text("a", "still working")))
        assertSame(waiting, waiting.next(AgentEvent.SessionMeta("a")))
    }

    @Test fun `newest only approval snapshot resolves through older pending before zero`() {
        val newest = approval.copy(call = approval.call.copy(id = "tool-2"))
        val first = AttentionState().read(mapOf("a" to PendingInput("a", newest, null)))
        val uncertain = first.next(AgentEvent.ToolResultReady("a", ToolResult("tool-2", "ok", false)))
        assertFalse(uncertain.known)
        assertEquals(first.pending, uncertain.pending)
        assertTrue(uncertain.resolved.isEmpty())
        val older = uncertain.read(mapOf("a" to PendingInput("a", approval, null)))
        assertTrue(older.known)
        assertEquals("tool-1", older.pending["a"]?.approval?.call?.id)
        val last = older.next(AgentEvent.ToolResultReady("a", ToolResult("tool-1", "ok", false)))
        assertEquals(setOf("a"), last.pending.keys)
        assertFalse(last.known)
        assertTrue(last.read(emptyMap()).pending.isEmpty())
    }

    @Test fun `all resolution signals retain waiting state until a successful full read`() {
        val waiting = waiting().read(waiting().pending)
        val signals = listOf(
            AgentEvent.QuestionResolved("a", "ask-1"),
            AgentEvent.QuestionResolved("a", "older-unobserved"),
            AgentEvent.ToolResultReady("a", ToolResult("tool-1", "ok", false)),
            AgentEvent.Done("a", null), AgentEvent.Error("a", "failed"),
        )
        signals.forEach { e ->
            val uncertain = waiting.next(e)
            assertFalse(uncertain.known)
            assertEquals(waiting.pending, uncertain.pending)
            assertTrue(uncertain.resolved.isEmpty())
            assertFalse(uncertain.read(null).known)
        }
    }

    @Test fun `authoritative reconnect drops stale waits and failed reads withdraw authority`() {
        val waiting = waiting().read(waiting().pending)
        val failed = waiting.read(null)
        assertFalse(failed.known)
        assertEquals(waiting.pending, failed.pending)
        assertTrue(failed.read(emptyMap()).pending.isEmpty())
        val snapshot = mapOf("c" to PendingInput("c", null, question), "empty" to PendingInput("empty", null, null))
        assertEquals(setOf("c"), waiting.read(snapshot).pending.keys)
    }

    @Test fun `resolution invalidates even an empty in flight snapshot`() {
        val reading = waiting().beginSnapshot()
        val later = reading.next(AgentEvent.QuestionResolved("a", "ask-1"))
        assertSame(later, later.reconcile(emptyMap(), reading.version))
        assertFalse(later.known)
        assertEquals(setOf("a", "b"), later.pending.keys)
        assertEquals(setOf("a", "b"), later.reconcile(null, reading.version).pending.keys)
    }

    @Test fun `newer inputs win over a snapshot and only latest read may replace state`() {
        val reading = waiting().beginSnapshot()
        val later = reading.next(AgentEvent.Question("c", question))
        assertEquals(setOf("c"), later.reconcile(emptyMap(), reading.version).pending.keys)
        val newerRead = reading.beginSnapshot()
        val fresh = newerRead.reconcile(emptyMap(), newerRead.version)
        assertTrue(fresh.known)
        assertSame(fresh, fresh.reconcile(waiting().pending, reading.version))
        assertSame(fresh, fresh.reconcile(null, reading.version))
        val disconnected = reading.invalidate()
        assertSame(disconnected, disconnected.reconcile(emptyMap(), reading.version))
    }

    @Test fun `unknown startup and resolution preserve notification authority until full snapshot`() {
        assertNull(AttentionNotices.update(ComputersState(), true, false, true))
        val opening = ComputersState(ready = true, activeId = "computer")
        assertFalse(AttentionNotices.update(opening, true, false, true)!!.authoritative)
        assertTrue(AttentionNotices.update(opening, false, false, true)!!.authoritative)
        val loaded = opening.copy(attention = AttentionState().read(emptyMap()))
        assertTrue(AttentionNotices.update(loaded, true, false, true)!!.authoritative)
        val uncertain = opening.copy(attention = waiting().next(AgentEvent.Done("a", null)), summaries = listOf(summary("a"), summary("b")))
        val notice = AttentionNotices.update(uncertain, true, false, true)!!
        assertFalse(notice.authoritative)
        assertTrue(notice.resolved.isEmpty())
        assertEquals(2, notice.waiting.size)
    }

    @Test fun `locked notice never includes chat title or question or command`() {
        val state = ComputersState(attention = waiting(), summaries = listOf(summary("a", title = "Private project")))
        val notices = AttentionNotices.of(state, true, true)
        assertEquals(1, notices.size)
        assertFalse(notices.single().text.contains("Private project"))
        assertEquals("tool-1", notices.single().callId)
    }
}
