package com.nekko.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A computer's page: the summary as the computer sends it, and the round trips the phone keeps (the iPhone's MachineModelTests). */
class MachineTest {
    @Test fun `decodes a machine summary`() {
        val raw = Json.parseToJsonElement(
            """
            {"version":"0.9.3","platform":"darwin","edition":"desktop","uptimeMs":273600000,
             "hardware":{"platform":"darwin","arch":"arm64","release":"25.1.0","cpu":{"model":"Apple M4 Max","cores":16},"ramBytes":137438953472,
                         "unified":true,"gpus":[{"name":"Apple M4 Max","vramBytes":137438953472,"cores":40}],"backends":["metal","cpu"],
                         "engine":{"backend":"metal","version":"b7000"},"diskFreeBytes":1000000000000},
             "live":{"cpuPct":12.5,"cpuCores":16,"memUsedMB":61000,"memTotalMB":131072,"temps":{"cpuC":48,"gpuC":51}},
             "gpu":{"source":"macos","devices":[{"name":"Apple M4 Max","memoryTotalMB":131072,"memoryUsedMB":15000,"temperatureC":55}],"unified":true,"totalMB":131072,"usedMB":15000,"freeMB":116072},
             "engine":{"running":true,"startedAt":1000,"resident":[{"id":"qwen3","name":"Qwen3 Coder","contextTokens":32768},{"id":"bare"}],"loading":1}}
            """,
        )
        val s = MachineSummary.from(raw)!!
        assertEquals("0.9.3", s.version)
        assertEquals(273_600_000L, s.uptimeMs)
        assertEquals("Apple M4 Max", s.cpuModel)
        assertEquals(16, s.cpuCores)
        assertTrue(s.unified)
        assertEquals(listOf(40), s.gpus.map { it.cores })
        assertEquals(listOf("metal", "cpu"), s.backends)
        assertEquals("b7000", s.engineVersion)
        assertEquals("the GPU probe's temperature wins over the system sensor", 55.0, s.gpuC!!, 0.0)
        assertEquals(15000.0, s.gpuUsedMB!!, 0.0)
        assertTrue(s.serverRunning)
        assertEquals(listOf("Qwen3 Coder", "bare"), s.resident.map { it.name })
        assertEquals(1, s.loading)
        assertNull(MachineSummary.from(JsonPrimitive("no")))
        val bare = MachineSummary.from(Json.parseToJsonElement("""{"uptimeMs":0}"""))!!
        assertFalse(bare.serverRunning)
        assertTrue(bare.resident.isEmpty())
    }

    @Test fun `round trips keep the last twenty and name their quality`() {
        var samples = emptyList<RoundTrip>()
        for (i in 0 until 25) samples = RoundTrips.append(samples, RoundTrip(i.toLong(), i * 10))
        assertEquals(20, samples.size)
        assertEquals(5L, samples.first().at)
        assertEquals(240, samples.last().ms)
        assertEquals("Fast", RoundTrips.quality(38))
        assertEquals("Good", RoundTrips.quality(120))
        assertEquals("Slow", RoundTrips.quality(500))
        assertEquals("Very slow", RoundTrips.quality(2000))
    }

    @Test fun `today is the usage summary's UTC day`() {
        assertEquals("2026-10-24", RoundTrips.dayKey(1_792_843_200_000))
    }
}
