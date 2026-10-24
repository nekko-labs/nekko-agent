package com.nekko.protocol

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MonitorSummaryTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    /** The shape `phoneMonitorView` writes (packages/shared/src/phone-views.ts), as in the phone golden. */
    private val sample = """
        {"hardware":{"cpu":{"loadPct":42.5,"cores":16,"tempC":71},"memory":{"usedMB":20000,"totalMB":65536,"tempC":48},
          "gpu":{"memoryUsedMB":9100,"memoryTotalMB":36852,"loadPct":87,"tempC":70}},
         "running":[{"id":"s1","title":"Fix the build","step":"approval","elapsedMs":0},
                    {"id":"s2","title":"Long one","step":"working","elapsedMs":252000},
                    {"id":"gone","title":"","step":"working"},
                    {"title":"no id"}],
         "needsYou":[{"sessionId":"s3","title":"Idle","kind":"question","callId":"q1","label":"Which auth method?","count":1,"since":300},
                     {"sessionId":"s1","title":"Fix the build","kind":"approval","callId":"tc1","risk":"high","label":"bash","since":500},
                     {"sessionId":"s4","kind":"note","callId":"x"}],
         "automations":[{"kind":"task","id":"t1","name":"Nightly","nextRunAt":3},{"kind":"workflow","id":"w1","name":"Review PRs","nextRunAt":4},
                        {"kind":"task","id":"t2","name":"never"}]}
    """

    @Test fun `reads hardware, running chats, what needs you and automations`() {
        val m = MonitorSummary.from(json(sample))
        assertEquals(MonitorSummary.Cpu(42.5, 16, 71.0), m.hardware.cpu)
        assertEquals(30.5, m.hardware.memory.usedPct, 0.1)
        assertEquals(48.0, m.hardware.memory.tempC!!, 0.0)
        assertEquals(MonitorSummary.Gpu(87.0, 70.0, 9100.0, 36852.0, unified = false), m.hardware.gpu)

        assertEquals(listOf("s1", "s2", "gone"), m.running.map { it.id })
        assertEquals(MonitorSummary.Step.APPROVAL, m.running[0].step)
        assertEquals(252_000L, m.running[1].elapsedMs)
        assertNull(m.running[2].elapsedMs)

        assertEquals(2, m.needsYou.size)
        val q = m.needsYou[0]
        assertEquals(MonitorSummary.Kind.QUESTION, q.kind)
        assertNull(q.risk)
        assertEquals(1, q.count)
        assertEquals("s3:question:q1", q.key)
        val a = m.needsYou[1]
        assertEquals(Severity.HIGH, a.risk)
        assertEquals("bash", a.label)
        assertEquals(setOf("s1", "s3"), m.waiting)

        assertEquals(listOf("t1", "w1"), m.automations.map { it.id })
        assertEquals(MonitorSummary.AutomationKind.WORKFLOW, m.automations[1].kind)
    }

    @Test fun `a computer with no gpu or sensors, and junk, read as empty rows`() {
        val m = MonitorSummary.from(json("""{"hardware":{"cpu":{"loadPct":3,"cores":8},"memory":{"usedMB":1,"totalMB":0},"gpu":null}}"""))
        assertNull(m.hardware.gpu)
        assertNull(m.hardware.cpu.tempC)
        assertEquals(0.0, m.hardware.memory.usedPct, 0.0)
        assertTrue(m.running.isEmpty() && m.needsYou.isEmpty() && m.automations.isEmpty())
        assertEquals(MonitorSummary(), MonitorSummary.from(null))
        assertEquals(MonitorSummary(), MonitorSummary.from(JsonPrimitive("nope")))
        // An approval without a risk reads as medium, as the computer's view defaults it.
        val r = MonitorSummary.from(json("""{"needsYou":[{"sessionId":"s","kind":"approval","callId":"c"}]}"""))
        assertEquals(Severity.MEDIUM, r.needsYou.single().risk)
        assertTrue(MonitorSummary.from(json("""{"hardware":{"gpu":{"unified":true}}}""")).hardware.gpu!!.unified)
    }

    @Test fun `elapsed and next run read as short phrases`() {
        assertEquals("0s", MonitorSummary.elapsed(-5))
        assertEquals("45s", MonitorSummary.elapsed(45_400))
        assertEquals("4m 12s", MonitorSummary.elapsed(252_000))
        assertEquals("1h 05m", MonitorSummary.elapsed(3_900_000))
        assertEquals("now", MonitorSummary.nextRun(1_000, 2_000))
        assertEquals("in 1m", MonitorSummary.nextRun(10_000, 0))
        assertEquals("in 2h 10m", MonitorSummary.nextRun(130 * 60_000L, 0))
        assertEquals("in 2h", MonitorSummary.nextRun(120 * 60_000L, 0))
        assertEquals("in 3d", MonitorSummary.nextRun(3 * 24 * 60 * 60_000L, 0))
        assertEquals(10_000L, MonitorSummary.POLL_MS)
    }

    /** Every `monitor:summary` result in the phone golden reads without dropping a row. */
    @Test fun `reads the phone golden`() {
        val f = File(System.getenv("NEKKO_REPO_ROOT") ?: "../../..", "crates/nekko-remote/tests/golden/phone.json")
        if (!f.exists()) return // running outside the monorepo
        val cases = mutableListOf<kotlinx.serialization.json.JsonObject>()
        fun walk(e: kotlinx.serialization.json.JsonElement) {
            when (e) {
                is kotlinx.serialization.json.JsonObject -> {
                    if (e.str("channel") == Channels.MONITOR_SUMMARY && e["result"] != null) cases += e
                    e.values.forEach(::walk)
                }
                is kotlinx.serialization.json.JsonArray -> e.forEach(::walk)
                else -> Unit
            }
        }
        walk(json(f.readText()))
        assertFalse("no monitor:summary case in the phone golden", cases.isEmpty())
        for (c in cases) {
            val raw = c["result"].obj()!!
            val m = MonitorSummary.from(raw)
            assertEquals(raw["running"].arr()!!.size, m.running.size)
            assertEquals(raw["needsYou"].arr()!!.size, m.needsYou.size)
            assertEquals(raw["automations"].arr()!!.size, m.automations.size)
            assertTrue(m.hardware.cpu.cores > 0)
        }
    }
}
