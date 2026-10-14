package com.nekko.android

import com.nekko.android.chat.PhoneEvent
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Approval
import com.nekko.protocol.AskOption
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import com.nekko.protocol.ToolResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneEventTest {
    private val sid = "s1"
    private val call = ToolCall("call-1", "bash", buildJsonObject { put("command", "rm -rf build") })

    @Test
    fun `turn endings and waits map to their event`() {
        assertEquals(PhoneEvent.FINISHED, PhoneEvent.of(AgentEvent.Done(sid, "m1")))
        assertEquals(PhoneEvent.FINISHED, PhoneEvent.of(AgentEvent.Done(sid, null)))
        assertEquals(PhoneEvent.FAILED, PhoneEvent.of(AgentEvent.Error(sid, "anthropic 401: invalid x-api-key")))
        assertEquals(PhoneEvent.APPROVAL, PhoneEvent.of(AgentEvent.ApprovalRequired(sid, Approval(call, "deletes files", Severity.HIGH))))
        val ask = AskRequest("ask-1", listOf(AskQuestion("q1", "Pick", "Which?", listOf(AskOption("A", null)), false)), 0)
        assertEquals(PhoneEvent.NEEDS_INPUT, PhoneEvent.of(AgentEvent.Question(sid, ask)))
    }

    @Test
    fun `a stopped turn is not a failure`() {
        assertNull(PhoneEvent.of(AgentEvent.Error(sid, "Stopped")))
        // A stop between two steps of the loop (loop.ts, run.rs).
        assertNull(PhoneEvent.of(AgentEvent.Error(sid, "Aborted")))
    }

    @Test
    fun `progress in between is not an event`() {
        listOf(
            AgentEvent.Text(sid, "Hel"),
            AgentEvent.Reasoning(sid, "hmm"),
            AgentEvent.ToolCallStarted(sid, call),
            AgentEvent.ToolResultReady(sid, ToolResult("call-1", "ok", false)),
            AgentEvent.QuestionResolved(sid, "ask-1"),
            AgentEvent.Usage(sid, 10, 100),
            AgentEvent.Retry(sid),
            AgentEvent.SessionMeta(sid),
            AgentEvent.Other(sid, "image_status"),
        ).forEach { assertNull(it.toString(), PhoneEvent.of(it)) }
    }

    @Test
    fun `decoded wire events map the same way`() {
        fun wire(json: String) = AgentEvent.from(Json.parseToJsonElement(json))!!
        assertEquals(PhoneEvent.FINISHED, PhoneEvent.of(wire("""{"type":"done","sessionId":"s1","messageId":"m1","stop":"loop"}""")))
        assertEquals(PhoneEvent.FAILED, PhoneEvent.of(wire("""{"type":"error","sessionId":"s1"}""")))
        assertNull(PhoneEvent.of(wire("""{"type":"error","sessionId":"s1","message":"Stopped"}""")))
        assertEquals(
            PhoneEvent.APPROVAL,
            PhoneEvent.of(wire("""{"type":"tool_approval_required","sessionId":"s1","call":{"id":"c","name":"bash","input":{}},"reason":"r","severity":"high"}""")),
        )
    }
}
