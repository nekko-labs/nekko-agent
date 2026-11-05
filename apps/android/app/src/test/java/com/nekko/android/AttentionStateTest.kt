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

    @Test fun `distinct chats not repeated events or inputs determine badge units`() {
        val waiting = waiting().next(AgentEvent.ApprovalRequired("a", approval))
        val state = ComputersState(attention = waiting, summaries = listOf(summary("a"), summary("b")))
        assertEquals(setOf("a", "b"), AttentionNotices.of(state, true, false).map { it.sessionId }.toSet())
        assertEquals(2, AttentionNotices.of(state, true, false).size)
        assertTrue(AttentionNotices.of(state, false, false).isEmpty())
        assertEquals(1, AttentionNotices.of(state.copy(summaries = listOf(summary("a"))), true, false).size)
        assertTrue(AttentionNotices.of(state.copy(summaries = emptyList()), true, false).isEmpty())
    }

    @Test fun `viewing or streaming is not resolution and one remaining input keeps the chat waiting`() {
        val waiting = waiting()
        assertSame(waiting, waiting.next(AgentEvent.Text("a", "still working")))
        assertSame(waiting, waiting.next(AgentEvent.SessionMeta("a")))
        val approved = waiting.answered("a", "tool-1", approval = true)
        assertEquals(setOf("a", "b"), approved.pending.keys)
        assertNull(approved.pending["a"]?.approval)
        assertNotNull(approved.pending["a"]?.question)
        assertEquals(setOf("b"), approved.answered("a", "ask-1", approval = false).pending.keys)
    }

    @Test fun `only matching resolution clears an input and done or failed clears a chat`() {
        val waiting = waiting()
        assertSame(waiting, waiting.next(AgentEvent.QuestionResolved("a", "old-question")))
        assertSame(waiting, waiting.answered("a", "old-tool", approval = true))
        val questionResolved = waiting.next(AgentEvent.QuestionResolved("a", "ask-1"))
        assertNotNull(questionResolved.pending["a"]?.approval)
        val resolved = questionResolved.next(AgentEvent.ToolResultReady("a", ToolResult("tool-1", "ok", false)))
        assertEquals(setOf("b"), resolved.pending.keys)
        assertEquals(setOf("b"), waiting.next(AgentEvent.Done("a", null)).pending.keys)
        assertEquals(setOf("b"), waiting.next(AgentEvent.Error("a", "failed")).pending.keys)
        assertEquals(setOf("b"), waiting.dismiss(E2E.activityTag("a")).pending.keys)
        assertEquals(waiting.pending, waiting.dismiss(E2E.activityTag("unknown")).pending)
    }

    @Test fun `authoritative reconnect drops stale waits and restores new ones but failed read is unknown`() {
        val waiting = waiting()
        assertSame(waiting, waiting.reconcile(null, waiting.version))
        assertTrue(waiting.reconcile(emptyMap(), waiting.version).pending.isEmpty())
        val snapshot = mapOf("c" to PendingInput("c", null, question), "empty" to PendingInput("empty", null, null))
        assertEquals(setOf("c"), waiting.reconcile(snapshot, waiting.version).pending.keys)
    }

    @Test fun `in flight snapshots cannot resurrect resolved inputs or erase newer waits`() {
        val waiting = waiting()
        val requestedAt = waiting.version
        val later = waiting.next(AgentEvent.Done("a", null)).next(AgentEvent.Question("c", question))
        assertEquals(setOf("b", "c"), later.reconcile(waiting.pending, requestedAt).pending.keys)
        val unseen = AttentionState().next(AgentEvent.QuestionResolved("a", "ask-1"))
        assertTrue(unseen.reconcile(mapOf("a" to PendingInput("a", null, question)), 0).pending.isEmpty())
        val dismissedBeforeSnapshot = AttentionState().dismiss(E2E.activityTag("a"))
        val snapshot = mapOf("a" to PendingInput("a", null, question))
        assertTrue(dismissedBeforeSnapshot.reconcile(snapshot, 0).pending.isEmpty())
        assertEquals(setOf("a"), dismissedBeforeSnapshot.next(AgentEvent.Question("a", question)).reconcile(snapshot, 0).pending.keys)
    }

    @Test fun `launching and reconnecting with unknown state are not an empty snapshot`() {
        assertNull(AttentionNotices.update(ComputersState(), true, false, true))
        val opening = ComputersState(ready = true, activeId = "computer")
        assertFalse(AttentionNotices.update(opening, true, false, true)!!.authoritative)
        assertTrue(AttentionNotices.update(opening, false, false, true)!!.authoritative)
        val loaded = opening.copy(attention = AttentionState().reconcile(emptyMap(), 0))
        assertTrue(AttentionNotices.update(loaded, true, false, true)!!.authoritative)
    }

    @Test fun `locked notice never includes chat title or question or command`() {
        val state = ComputersState(attention = waiting(), summaries = listOf(summary("a", title = "Private project")))
        val notices = AttentionNotices.of(state, true, true)
        assertEquals(1, notices.size)
        assertFalse(notices.single().text.contains("Private project"))
        assertEquals("tool-1", notices.single().callId)
    }
}
