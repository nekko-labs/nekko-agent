package com.nekko.android

import com.nekko.android.voice.ComputerVoice
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.Engine
import com.nekko.android.voice.EngineChoice
import com.nekko.android.voice.Wav
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class DictationTest {
    private val ready = ComputerVoice(online = true, installed = true, enabled = true)
    private val notInstalled = ready.copy(installed = false)
    private val off = ready.copy(enabled = false)
    private val offline = ready.copy(online = false)

    @Test
    fun `the WAV header is exactly what the computer's validate_wav accepts`() {
        val samples = ShortArray(Wav.SAMPLE_RATE) { (it % 100 - 50).toShort() }
        val b = ByteBuffer.wrap(Wav.encode(samples)).order(ByteOrder.LITTLE_ENDIAN)
        val bytes = b.array()
        fun ascii(at: Int, n: Int) = String(bytes, at, n, Charsets.US_ASCII)
        assertEquals("RIFF", ascii(0, 4))
        assertEquals("WAVE", ascii(8, 4))
        assertEquals("fmt ", ascii(12, 4))
        assertEquals(16, b.getInt(16))
        assertEquals(1, b.getShort(20).toInt()) // PCM
        assertEquals(1, b.getShort(22).toInt()) // mono
        assertEquals(16_000, b.getInt(24))
        assertEquals(16, b.getShort(34).toInt()) // 16-bit
        assertEquals("data", ascii(36, 4))
        assertEquals(bytes.size - 44, b.getInt(40))
        assertEquals(36 + Wav.SAMPLE_RATE * 2, b.getInt(4))
        assertEquals(samples[1], b.getShort(46))
    }

    @Test
    fun `the phone's cap fits the relay and the computer`() {
        val wavBytes = Wav.HEADER + Wav.MAX_SAMPLES * 2
        assertTrue("within the computer's 60 s", wavBytes <= 44 + 16_000 * 2 * Wav.COMPUTER_MAX_SECONDS)
        // As a sealed JSON number array: worst case 4 chars per byte ("255,"), then base64.
        val sealedWorst = wavBytes * 4 * 4 / 3
        assertTrue("under the relay's 10 MB frame, worst case $sealedWorst", sealedWorst < 10 * 1024 * 1024)
    }

    @Test
    fun `encode keeps only the recorded part`() {
        val buf = ShortArray(100) { 7 }
        assertEquals(44 + 20, Wav.encode(buf, 10).size)
        assertArrayEquals(Wav.encode(ShortArray(0)), Wav.encode(buf, 0))
    }

    @Test
    fun `computer first uses Whisper when ready, else the phone`() {
        assertEquals(Engine.COMPUTER, Dictation.engine(EngineChoice.COMPUTER_FIRST, ready, phoneAvailable = true))
        assertEquals(Engine.PHONE, Dictation.engine(EngineChoice.COMPUTER_FIRST, notInstalled, phoneAvailable = true))
        assertEquals(Engine.PHONE, Dictation.engine(EngineChoice.COMPUTER_FIRST, offline, phoneAvailable = true))
        assertNull(Dictation.engine(EngineChoice.COMPUTER_FIRST, off, phoneAvailable = false))
    }

    @Test
    fun `computer only never falls back to the phone`() {
        assertEquals(Engine.COMPUTER, Dictation.engine(EngineChoice.COMPUTER_ONLY, ready, phoneAvailable = true))
        assertNull(Dictation.engine(EngineChoice.COMPUTER_ONLY, off, phoneAvailable = true))
        assertEquals("Nekko Voice is turned off on Mac (Settings → Nekko Voice there).", Dictation.why(EngineChoice.COMPUTER_ONLY, off, true, "Mac"))
        assertEquals("Mac is offline.", Dictation.why(EngineChoice.COMPUTER_ONLY, offline, true, "Mac"))
    }

    @Test
    fun `phone only never uses the computer`() {
        assertEquals(Engine.PHONE, Dictation.engine(EngineChoice.PHONE, ready, phoneAvailable = true))
        assertNull(Dictation.engine(EngineChoice.PHONE, ready, phoneAvailable = false))
    }

    @Test
    fun `dictated text goes in at the cursor and never replaces typed text`() {
        assertEquals("hello world" to 11, Dictation.insert("", 0, " hello world"))
        assertEquals("Please summarise this" to 21, Dictation.insert("Please", 6, "summarise this"))
        assertEquals("a b c" to 3, Dictation.insert("a c", 1, "b"))
        // Whisper's markers for silence or noise are not words.
        assertEquals("" to 0, Dictation.insert("", 0, " [BLANK_AUDIO]"))
        assertEquals("ok go" to 5, Dictation.insert("ok", 2, "(music) go"))
        for (tag in listOf("[BLANK_AUDIO]", " [ Silence ]", "[Music]", "[MUSIC PLAYING]", "(wind blowing)")) {
            assertEquals(tag, "", Dictation.clean(tag))
        }
        // Real words around a tag are kept, and so is ordinary punctuation.
        assertEquals("fix the build, then deploy.", Dictation.clean("fix the build, [BLANK_AUDIO] then deploy."))
    }

    @Test
    fun `the recording clock counts to the cap`() {
        assertEquals("0:00 / 0:30", Dictation.clock(0))
        assertEquals("0:07 / 0:30", Dictation.clock(7 * 16_000 + 100))
    }
}
