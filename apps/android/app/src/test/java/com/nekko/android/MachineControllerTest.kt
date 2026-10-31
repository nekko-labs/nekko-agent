package com.nekko.android

import com.nekko.android.computer.MachineController
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A computer's page: one refresh pass, an older computer, and nothing asked while it isn't the one in use. */
class MachineControllerTest {
    private fun json(s: String): JsonElement = com.nekko.protocol.WireJson.parseToJsonElement(s)
    private val now = 1_792_843_200_000L

    @Test fun `one pass times the round trip, then reads the summary, models and usage`() = runTest {
        var t = 0L
        var models = 0
        val caller = FakeCaller {
            when (it.channel) {
                Channels.APP_INFO -> { t += 42_000_000; json("""{"version":"0.9.3"}""") }
                Channels.MACHINE_SUMMARY -> json("""{"version":"0.9.3","uptimeMs":60000,"engine":{"running":true,"resident":[{"id":"qwen3"}]}}""")
                Channels.USAGE_SUMMARY -> json("""{"totalCost":3.5,"daily":[{"date":"2026-10-24","input":1000,"output":500,"cost":1.25}]}""")
                else -> JsonNull
            }
        }
        val m = MachineController(caller, backgroundScope, reachable = { true }, loadModels = { models++ }, now = { now }, clock = { t })
        m.refresh()
        val s = m.state.value
        assertEquals(listOf(Channels.APP_INFO, Channels.MACHINE_SUMMARY, Channels.USAGE_SUMMARY), caller.channels())
        assertEquals(42, s.latest!!.ms)
        assertEquals("0.9.3", s.summary!!.version)
        assertEquals(setOf("qwen3"), s.loadedIds)
        assertNull(s.summaryError)
        assertEquals(1, models)
        assertEquals(1.25, s.today(now)!!.cost, 0.0)
        assertEquals(1500L, s.today(now)!!.tokens)
        assertTrue(s.loadedOnce)
        assertFalse(s.loading)
    }

    @Test fun `an older computer says why the details are missing, and keeps the round trip`() = runTest {
        val caller = FakeCaller {
            when (it.channel) {
                Channels.MACHINE_SUMMARY -> throw RelayException("channel-denied")
                Channels.APP_INFO -> json("{}")
                else -> JsonNull
            }
        }
        val m = MachineController(caller, backgroundScope, reachable = { true }, now = { now })
        m.refresh()
        assertEquals("This computer is too old to send its details. Update Nekko Agent there.", m.state.value.summaryError)
        assertEquals(1, m.state.value.samples.size)
    }

    @Test fun `nothing is asked of a computer that isn't the one in use`() = runTest {
        val caller = FakeCaller { JsonNull }
        val m = MachineController(caller, backgroundScope, reachable = { false })
        m.refresh()
        assertTrue(caller.calls.isEmpty())
        assertFalse(m.state.value.loadedOnce)
    }
}
