package com.nekko.android

import com.nekko.android.beyond.AutomationsController
import com.nekko.android.beyond.UsageController
import com.nekko.protocol.Channels
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-29: automations with Run now only, and usage and limits by provider id, with the iPhone's BeyondTests data. */
@OptIn(ExperimentalCoroutinesApi::class)
class AutomationsUsageTest {
    private fun computer() = FakeCaller { c ->
        when (c.channel) {
            Channels.TASKS_LIST -> Json.parseToJsonElement("""[{"id":"t1","title":"Nightly tests","kind":"recurring","intervalMs":86400000,"status":"active","runCount":3,"lastResult":"All 40 passed.","lastRunAt":5}]""")
            Channels.WORKFLOWS_LIST -> Json.parseToJsonElement("""[{"id":"w1","name":"Review PRs","category":"Code","enabled":true,"stepCount":2,"lastStatus":"failure"}]""")
            Channels.USAGE_SUMMARY -> Json.parseToJsonElement("""{"totalInput":1000,"totalOutput":500,"totalCost":1.25,"byModel":[{"model":"claude-opus-5.5","input":600,"output":300,"cost":1}],"daily":[{"date":"2026-10-19","input":10,"output":5,"cost":0.25}]}""")
            Channels.LIMITS_GET -> when (c.args.first().jsonPrimitive.content) {
                "claude" -> Json.parseToJsonElement("""{"planType":"max","windows":[{"id":"w","label":"5 hours","usedPercent":140,"resetAt":9,"status":"warning"}]}""")
                "broken" -> throw RelayException("timed out")
                else -> JsonNull
            }
            else -> JsonNull
        }
    }

    @Test fun `automations list, and Run now only`() = runTest {
        val c = computer()
        var online = true
        val a = AutomationsController(c, { online }, backgroundScope)
        a.load()
        assertNull(a.state.value.error)
        assertEquals(listOf("Nightly tests"), a.state.value.tasks.map { it.title })
        assertEquals("All 40 passed.", a.state.value.tasks[0].lastResult)
        assertEquals(listOf("Review PRs"), a.state.value.workflows.map { it.name })
        a.runTask("t1")
        a.runWorkflow("w1")
        assertEquals(listOf("""["t1"]"""), c.calls.filter { it.channel == Channels.TASK_RUN_NOW }.map { JsonArray(it.args).toString() })
        assertEquals(listOf("""["w1"]"""), c.calls.filter { it.channel == Channels.WORKFLOW_RUN }.map { JsonArray(it.args).toString() })
        assertEquals(setOf("t1", "w1"), a.state.value.started)
        // The list is read again so the run's result shows, keeping what was started.
        val reads = c.calls.count { it.channel == Channels.TASKS_LIST }
        advanceTimeBy(1_600)
        runCurrent()
        assertTrue(c.calls.count { it.channel == Channels.TASKS_LIST } > reads)
        assertEquals(setOf("t1", "w1"), a.state.value.started)
        // Offline: never sent later.
        online = false
        val e = runCatching { a.runTask("t1") }.exceptionOrNull()
        assertEquals(AutomationsController.RUN_OFFLINE, e?.message)
        assertEquals(1, c.calls.count { it.channel == Channels.TASK_RUN_NOW })
    }

    @Test fun `usage and limits by provider id`() = runTest {
        val c = computer()
        val providers = listOf(
            PublicProvider("p", "openai", "P", true),
            PublicProvider("claude", "anthropic", "Claude", true),
            PublicProvider("broken", "anthropic", "Broken", true),
            PublicProvider("off", "openai", "Off", false),
        )
        val u = UsageController(c) { providers }
        u.load()
        val s = u.state.value
        assertNull(s.error)
        assertEquals(1500L, s.summary?.totalTokens)
        assertEquals("only providers that reported limits get a card; a failed read leaves none", listOf("claude"), s.limited.map { it.first.id })
        assertEquals(100.0, s.limited.single().second.windows.single().usedPercent, 0.0)
        assertTrue("limits are asked by provider id, never for a disabled one", c.calls.none { it.channel == Channels.LIMITS_GET && it.args.first().jsonPrimitive.content == "off" })
    }
}
