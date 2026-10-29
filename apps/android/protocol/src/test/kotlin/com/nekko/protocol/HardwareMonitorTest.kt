package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Expert monitor's readings as the computer sends them (phone-views.ts); the iPhone's MonitorTests. */
class HardwareMonitorTest {
    private fun json(s: String) = WireJson.parseToJsonElement(s)

    @Test fun `reads hardware`() {
        val s = SystemStats.from(json("""{"cpuPct":41,"cpuCores":16,"memUsedMB":8192,"memTotalMB":32768,"temps":{"cpuC":61.5}}"""))!!
        assertEquals(41.0, s.cpuPct, 0.0)
        assertEquals(16, s.cpuCores)
        assertEquals(0.25, s.memFraction!!, 0.0)
        assertEquals(61.5, s.cpuC!!, 0.0)
        assertNull(s.gpuC)
        assertNull(SystemStats.from(null))
        assertNull("no CPU reading", SystemStats.from(json("""{"memUsedMB":1}""")))
        assertNull(SystemStats(cpuPct = 1.0, memUsedMB = 1.0).memFraction)

        val g = GpuStats.from(json("""{"totalMB":24000,"usedMB":6000,"unified":true,"devices":[{"utilizationPct":77},"junk"]}"""))!!
        assertEquals(1, g.devices.size)
        assertEquals(77.0, g.devices[0].utilizationPct!!, 0.0)
        assertEquals(0.25, g.memFraction!!, 0.0)
        assertTrue(g.unified)
    }

    @Test fun `reads the model server`() {
        val e = EngineStatus.from(
            json(
                """{"installed":true,"running":true,
                "resident":[{"id":"google/gemma-4-e4b","contextLength":32768,"vramBytes":4000000000,"sizeBytes":9,"loadedOn":"gpu","gpuLayers":42,"totalLayers":42},
                            {"id":"qwen","sizeBytes":4000000000,"loadedOn":"gpu+cpu"},{"contextLength":1}],
                "loading":[{"id":"llama","phase":"loading","progress":0.5}],
                "memory":{"budgetBytes":16000000000,"kind":"vram"}}""",
            ),
        )!!
        assertEquals(listOf("google/gemma-4-e4b", "qwen"), e.resident.map { it.id })
        assertEquals("GPU memory beats the file size", 4_000_000_000L, e.resident[0].bytes)
        assertFalse(e.resident[0].split)
        assertTrue(e.resident[1].split)
        assertEquals(0.5, e.loading.single().progress!!, 0.0)
        assertEquals(0.5, e.memFraction!!, 0.0)
        assertEquals("vram", e.memoryKind)
        val off = EngineStatus.from(json("""{"installed":false,"running":false}"""))!!
        assertTrue(off.resident.isEmpty())
        assertNull(off.memFraction)
    }

    @Test fun `reads a chat context`() {
        val c = ContextUsage.from(json("""{"usedTokens":96000,"contextWindow":128000,"sources":{"system":1200,"conversation":90000,"memory":0,"attached-file":4800}}"""))!!
        assertEquals(listOf("conversation", "attached-file", "system"), c.sources.map { it.first })
        assertEquals(0.75, c.fraction!!, 0.0)
        assertEquals(MonitorTone.WARN, c.tone)
        assertEquals(MonitorTone.HOT, ContextUsage(120_000, 128_000).tone)
        assertEquals(MonitorTone.OK, ContextUsage(10, 128_000).tone)
        val unknown = ContextUsage.from(json("""{"usedTokens":10,"contextWindow":0}"""))!!
        assertNull(unknown.contextWindow)
        assertNull(unknown.fraction)
        assertEquals(MonitorTone.OK, unknown.tone)
        assertNull(ContextUsage.from(json("""{"contextWindow":5}""")))
    }

    @Test fun `tones and formats`() {
        assertEquals(MonitorTone.OK, MonitorTone.of(0.5))
        assertEquals(MonitorTone.WARN, MonitorTone.of(0.8))
        assertEquals(MonitorTone.HOT, MonitorTone.of(0.95))
        assertEquals(MonitorTone.WARN, MonitorTone.temperature(85.0))
        assertEquals(MonitorTone.HOT, MonitorTone.temperature(91.0))
        assertEquals("950", MonitorFormat.tokens(950))
        assertEquals("12.3k", MonitorFormat.tokens(12_340))
        assertEquals("2k", MonitorFormat.tokens(2_000))
        assertEquals("131k", MonitorFormat.tokens(131_072))
        assertEquals("1.05M", MonitorFormat.tokens(1_050_000))
        assertEquals("12.3k / 128k", MonitorFormat.context(12_300, 128_000))
        assertEquals("950", MonitorFormat.context(950, null))
        assertEquals("–", MonitorFormat.context(null, 128_000))
        assertEquals("4 GB", MonitorFormat.bytes(4_294_967_296))
        assertEquals("4.7 GB", MonitorFormat.bytes(5_100_000_000))
        assertEquals("500 MB", MonitorFormat.bytes(524_288_000))
        assertEquals("9.4 / 32 GB", MonitorFormat.memory(9626.0, 32768.0))
        assertEquals("41%", MonitorFormat.percent(0.41))
        assertEquals("–", MonitorFormat.percent(null))
    }

    @Test fun `effort levels follow the model`() {
        val native = listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
        assertEquals(native, Effort.levels("claude-opus-4-7"))
        assertEquals(native, Effort.levels("anthropic/claude-fable-5-1"))
        assertEquals(native, Effort.levels("us.anthropic.claude-sonnet-5-5"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels("claude-sonnet-4-5"))
        assertEquals(listOf(Effort.LOW, Effort.MEDIUM, Effort.NORMAL, Effort.HIGH), Effort.levels("gpt-5.1"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels("gemma-4"))
        assertEquals(listOf(Effort.LOW, Effort.NORMAL, Effort.HIGH), Effort.levels(null))
        assertEquals(Effort.XHIGH, Effort.parse("xhigh"))
        assertNull(Effort.parse("ultra"))
    }

    @Test fun `the session carries its effort`() {
        assertEquals("high", Session.from(json("""{"id":"s","effort":"high"}"""))!!.effort)
        assertNull(Session.from(json("""{"id":"s"}"""))!!.effort)
    }
}
