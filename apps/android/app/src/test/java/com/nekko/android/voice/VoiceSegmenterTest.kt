package com.nekko.android.voice

import org.junit.Assert.*
import org.junit.Test

class VoiceSegmenterTest {
    private val rate = 1000
    private fun pcm(seconds: Double, value: Float = 0f) = FloatArray((seconds * rate).toInt()) { value }
    private fun drain(s: VoiceSegmenter, first: FloatArray? = null): List<FloatArray> {
        val out = mutableListOf<FloatArray>()
        first?.let { out += it }
        while (true) out += s.flush() ?: break
        return out
    }
    @Test fun `long silence and a short click never produce words`() {
        val s = VoiceSegmenter(rate)
        assertNull(s.feed(pcm(100.0)))
        assertNull(s.feed(pcm(0.1, 0.5f)))
        assertTrue(drain(s, s.feed(pcm(2.0))).isEmpty())
    }
    @Test fun `silence cut includes bounded pre roll and only emits once`() {
        val s = VoiceSegmenter(rate)
        s.feed(pcm(3.0))
        s.feed(pcm(0.5, 0.4f))
        val cut = s.feed(pcm(1.4))!!
        assertEquals(2100, cut.size) // 300 ms pre-roll, 500 ms voice, >1200 ms trailing silence
        assertNull(s.flush())
    }
    @Test fun `flush keeps voice shorter than a pause but not a tap`() {
        val s = VoiceSegmenter(rate)
        s.feed(pcm(0.3, 0.4f))
        assertEquals(300, s.flush()!!.size)
        assertNull(s.flush())
        s.feed(pcm(0.2, 0.4f))
        assertNull(s.flush())
    }
    @Test fun `analysis does not depend on input chunk size`() {
        val audio = pcm(0.7) + pcm(0.65, 0.5f) + pcm(1.4) + pcm(0.65, 0.5f) + pcm(1.4)
        val one = VoiceSegmenter(rate)
        val expected = drain(one, one.feed(audio))
        val split = VoiceSegmenter(rate)
        val actual = mutableListOf<FloatArray>()
        audio.asList().chunked(37).forEach { split.feed(it.toFloatArray())?.let { segment -> actual += segment } }
        actual += drain(split)
        assertEquals(2, expected.size); assertEquals(expected.size, actual.size)
        expected.zip(actual).forEach { (a, b) -> assertArrayEquals(a, b, 0f) }
    }
    @Test fun `maximum length cuts continuous voice and discard loses every tail`() {
        val s = VoiceSegmenter(rate, maxSeconds = 1.0)
        val segments = drain(s, s.feed(pcm(2.5, 0.5f)))
        assertEquals(listOf(1000, 1000, 500), segments.map { it.size })
        s.feed(pcm(0.5, 0.5f)); s.discard(); assertNull(s.flush())
    }
    @Test fun `short PCM input uses the same amplitude scale`() {
        val s = VoiceSegmenter(rate)
        s.feed(ShortArray(500) { 16384 })
        assertTrue(s.flush()!!.all { it == 0.5f })
    }
    @Test(expected = IllegalArgumentException::class) fun `invalid sample rate is rejected`() { VoiceSegmenter(0) }
}
