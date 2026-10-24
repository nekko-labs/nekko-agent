package com.nekko.android

import com.nekko.android.monitors.MonitorsController
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.Channels
import com.nekko.protocol.MonitorSummary
import com.nekko.protocol.RelayException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MonitorsControllerTest {
    private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)

    private val summary = json(
        """{"hardware":{"cpu":{"loadPct":40,"cores":8},"memory":{"usedMB":1024,"totalMB":4096}},
            "running":[{"id":"s1","title":"Fix","step":"approval","elapsedMs":5000}],
            "needsYou":[{"sessionId":"s1","title":"Fix","kind":"approval","callId":"tc1","risk":"high","label":"bash","since":1},
                        {"sessionId":"s2","title":"Ask","kind":"question","callId":"q1","label":"Which?","count":1,"since":2}],
            "automations":[]}""",
    )

    @Test fun `reads monitor summary and counts running time from the read`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.MONITOR_SUMMARY) summary else JsonNull }
        val c = MonitorsController(caller, { "Mac" }, now = { 1_000 })
        c.refresh()
        val s = c.state.value
        assertFalse(s.loading)
        assertEquals(1_000L, s.readAt)
        assertEquals(listOf("s1"), s.summary!!.running.map { it.id })
        assertEquals(2, s.needsYou.size)
        assertEquals(listOf(Channels.MONITOR_SUMMARY), caller.channels())
        // The phone's arguments are ignored by the computer; it sends none.
        assertTrue(caller.calls.single().args.isEmpty())
    }

    @Test fun `read off shows its own state, other errors keep the last answer`() = runTest {
        var fail: String? = null
        val caller = FakeCaller {
            fail?.let { m -> throw RelayException(m) }
            summary
        }
        val c = MonitorsController(caller, { "Mac" })
        c.refresh()
        fail = "Mac is offline"
        c.refresh()
        assertEquals("Mac is offline", c.state.value.error)
        assertEquals(1, c.state.value.summary!!.running.size)
        fail = "Not allowed from a paired phone (read-off): monitor:summary"
        c.refresh()
        assertTrue(c.state.value.readOff)
        assertNull(c.state.value.summary)
        fail = null
        c.refresh()
        assertFalse(c.state.value.readOff)
    }

    @Test fun `polls every ten seconds until cancelled`() = runTest {
        val caller = FakeCaller { summary }
        val c = MonitorsController(caller, { "Mac" })
        val job = launch { c.poll() }
        runCurrent()
        assertEquals(1, caller.calls.size)
        advanceTimeBy(MonitorSummary.POLL_MS - 1)
        runCurrent()
        assertEquals(1, caller.calls.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, caller.calls.size)
        job.cancel()
        advanceTimeBy(MonitorSummary.POLL_MS * 3)
        assertEquals("no read in the background", 2, caller.calls.size)
    }

    @Test fun `allow and deny go through tool approve, and the row hides until the next read drops it`() = runTest {
        val caller = FakeCaller { if (it.channel == Channels.MONITOR_SUMMARY) summary else JsonNull }
        val c = MonitorsController(caller, { "Mac" })
        c.refresh()
        val row = c.state.value.needsYou.first { it.kind == MonitorSummary.Kind.APPROVAL }
        c.decide(row, ok = false)
        val call = caller.calls.last()
        assertEquals(Channels.TOOL_APPROVE, call.channel)
        assertEquals(listOf(JsonPrimitive("s1"), JsonPrimitive("tc1"), JsonPrimitive(false)), call.args)
        assertEquals(listOf("s2"), c.state.value.needsYou.map { it.sessionId })
        // Still pending on the next read (the computer hasn't caught up): still hidden.
        c.refresh()
        assertEquals(listOf("s2"), c.state.value.needsYou.map { it.sessionId })
    }

    @Test fun `answer reads the question from chat pending and sends chat answer`() = runTest {
        val caller = FakeCaller {
            when (it.channel) {
                Channels.MONITOR_SUMMARY -> summary
                Channels.CHAT_PENDING -> json(
                    """{"s2":{"question":{"callId":"q1","askedAt":2,"questions":[{"id":"qa","header":"Pick","question":"Which?","options":[{"label":"A"}]}]}}}""",
                )
                else -> JsonNull
            }
        }
        val c = MonitorsController(caller, { "Mac" })
        c.refresh()
        val row = c.state.value.needsYou.first { it.kind == MonitorSummary.Kind.QUESTION }
        val q = c.question(row)!!
        assertEquals("qa", q.questions.single().id)
        c.answer(row, listOf(AskAnswer("qa", listOf("A"))))
        val call = caller.calls.last()
        assertEquals(Channels.CHAT_ANSWER, call.channel)
        assertEquals("s2", call.args[0].jsonPrimitive.content)
        assertEquals("q1", call.args[1].jsonPrimitive.content)
        assertEquals("qa", (call.args[2] as JsonArray)[0].jsonObject["questionId"]!!.jsonPrimitive.content)
        assertTrue(c.state.value.needsYou.none { it.kind == MonitorSummary.Kind.QUESTION })
    }

    @Test fun `only events that change what needs you trigger a read`() {
        val c = MonitorsController(FakeCaller(), { "Mac" })
        assertTrue(c.changes(AgentEvent.Done("s", null)))
        assertTrue(c.changes(AgentEvent.QuestionResolved("s", "q")))
        assertFalse(c.changes(AgentEvent.Text("s", "hi")))
    }
}
