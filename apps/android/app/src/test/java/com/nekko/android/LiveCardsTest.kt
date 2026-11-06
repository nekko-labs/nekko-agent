package com.nekko.android

import com.nekko.android.connection.LiveCards
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Approval
import com.nekko.protocol.AskOption
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.Severity
import com.nekko.protocol.ToolCall
import com.nekko.protocol.WireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Lock Screen card on Android: what each run is doing, which chats the card shows, and Next. */
class LiveCardsTest {
    private fun summary(json: String) = SessionSummary.from(WireJson.parseToJsonElement(json))!!
    private val bash = ToolCall("call_1", "bash", JsonObject(mapOf("command" to JsonPrimitive("npm test"))))

    @Test fun `a run's step follows its events, and an approval waits with its call`() {
        var r = LiveCards.next(null, AgentEvent.Text("s", "Hi"), 10.0)!!
        assertEquals("Writing…", r.step)
        assertEquals(10.0, r.startedAt!!, 0.0)
        r = LiveCards.next(r, AgentEvent.ToolCallStarted("s", bash), 11.0)!!
        assertEquals("Run npm test", r.step)
        r = LiveCards.next(r, AgentEvent.ApprovalRequired("s", Approval(bash, "deletes files", Severity.HIGH)), 12.0)!!
        assertTrue(r.needsYou)
        assertEquals("call_1", r.callId)
        assertEquals("high", r.severity)
        // Text while it waits doesn't hide what it waits for.
        r = LiveCards.next(r, AgentEvent.Text("s", "…"), 13.0)!!
        assertEquals("Run npm test", r.step)
        r = LiveCards.next(r, AgentEvent.ToolResultReady("s", com.nekko.protocol.ToolResult("call_1", "ok", false)), 14.0)!!
        assertFalse(r.needsYou)
        assertNull(r.callId)
        r = LiveCards.next(r, AgentEvent.Done("s", "m1"), 20.0)!!
        assertEquals(20.0, r.finishedAt!!, 0.0)
        // A new turn starts again.
        val again = LiveCards.next(r, AgentEvent.Text("s", "x"), 30.0)!!
        assertEquals(30.0, again.startedAt!!, 0.0)
        assertNull(again.finishedAt)
        val q = AskRequest("q1", listOf(AskQuestion("a", "Platform", "Which platform?", listOf(AskOption("iOS", "")), false)), 0)
        val asked = LiveCards.next(null, AgentEvent.Question("s", q), 1.0)!!
        assertEquals("Which platform?", asked.step)
        assertTrue(asked.needsYou)
        assertNull("a question has no call to Allow", asked.callId)
        assertTrue(LiveCards.next(null, AgentEvent.Error("s", "boom"), 1.0)!!.failed)
    }

    @Test fun `the card shows the computer's busy chats, finished runs and watches`() {
        val summaries = listOf(
            summary("""{"id":"n","title":"Ship the release","updatedAt":1}"""),
            summary("""{"id":"w","title":"Fix the reconnect","updatedAt":1,"lastReplyText":"Two tests left. Then done."}"""),
            summary("""{"id":"d","title":"Docs","updatedAt":1}"""),
            summary("""{"id":"pr","title":"Watch PR","updatedAt":1,"activeWatchCount":1}"""),
            summary("""{"id":"idle","title":"Idle","updatedAt":1}"""),
        )
        val runs = mapOf(
            "n" to LiveCards.Run(step = "Run npm test", needsYou = true, callId = "call_1", severity = "high", startedAt = 90.0),
            "w" to LiveCards.Run(step = "Edit reconnect.rs", startedAt = 80.0),
            "d" to LiveCards.Run(startedAt = 10.0, finishedAt = 50.0),
        )
        val activity = mapOf("n" to Activity.NEEDS_YOU, "w" to Activity.RUNNING)
        val chats = LiveCards.chats(summaries, activity, runs, now = 100.0).associateBy { it.id }
        assertEquals(setOf("n", "w", "d", "pr"), chats.keys)
        assertEquals(LiveChatState.NEEDS_YOU, chats["n"]!!.state)
        assertEquals("call_1", chats["n"]!!.callId)
        assertEquals("Ship the", chats["n"]!!.short)
        assertEquals("Edit reconnect.rs", chats["w"]!!.step)
        assertEquals("Two tests left.", chats["w"]!!.reply)
        assertEquals(80.0, chats["w"]!!.startedAt!!, 0.0)
        assertEquals(LiveChatState.DONE, chats["d"]!!.state)
        assertEquals(LiveChatState.WATCHING, chats["pr"]!!.state)
        assertEquals("Watching PR…", chats["pr"]!!.step)
        // The computer saying it needs you wins even before the phone saw the event.
        val cold = LiveCards.chats(summaries.take(1), activity, emptyMap(), 100.0).single()
        assertEquals("Needs you", cold.step)
        assertNull(cold.callId)
        // A finished run past the card's tail is gone.
        assertTrue(LiveCards.chats(summaries, emptyMap(), runs, now = 50.0 + LiveCard.FINISHED_TAIL + 1).none { it.id == "d" })

        val card = LiveCard.build(LiveCards.chats(summaries, activity, runs, 100.0), null, null, LiveLevel.STANDARD, 100.0)!!
        assertEquals("n", card.focusId)
        assertEquals("w", LiveCards.after(card.chats.map { it.id }, card.focusId))
        assertEquals("n", LiveCards.after(listOf("n", "w"), "w"))
        assertNull(LiveCards.after(emptyList(), null))
    }

    @Test fun `the first level follows the app lock`() {
        assertEquals(LiveLevel.MINIMAL, LiveCards.firstLevel(appLock = true))
        assertEquals(LiveLevel.STANDARD, LiveCards.firstLevel(appLock = false))
        assertEquals("Needs you", LiveCards.generic(LiveChatState.NEEDS_YOU))
    }
}
