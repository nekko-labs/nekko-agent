package com.nekko.android

import com.nekko.android.voice.ComputerVoice
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.Engine
import com.nekko.android.voice.EngineChoice
import com.nekko.android.voice.MicHardware
import com.nekko.android.voice.MicState
import com.nekko.android.voice.Wav
import com.nekko.protocol.Channels
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/** #2110: the composer's tap-mode dictation, cut at each pause and transcribed piece by piece (the iPhone's Dictation). */
@OptIn(ExperimentalCoroutinesApi::class)
class ContinuousDictationTest {
    /** A microphone the test speaks into, 100 ms at a time; Stop ends the stream. */
    private class StreamMic : MicHardware {
        val chunks = Channel<ShortArray>(Channel.UNLIMITED)
        val phoneSays = ArrayDeque<String>()
        var phoneCalls = 0
        override suspend fun record(onProgress: (Int, Float) -> Unit): ShortArray = error("one-shot not used")
        override suspend fun stream(onChunk: (ShortArray) -> Unit, onProgress: (Int, Float) -> Unit) {
            var n = 0
            for (c in chunks) {
                onChunk(c)
                n += c.size
                onProgress(n, Wav.level(c, c.size))
            }
        }
        override fun stopRecording() { chunks.close() }
        override fun phoneAvailable() = true
        override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String {
            phoneCalls++
            return phoneSays.removeFirstOrNull() ?: ""
        }
        override fun stopPhone() = Unit

        fun speak(seconds: Double) = repeat((seconds * 10).toInt()) {
            chunks.trySend(ShortArray(Wav.SAMPLE_RATE / 10) { i -> (sin(2 * PI * 220 * i / Wav.SAMPLE_RATE) * 8_000).toInt().toShort() })
        }
        fun pause(seconds: Double) = repeat((seconds * 10).toInt()) { chunks.trySend(ShortArray(Wav.SAMPLE_RATE / 10)) }
    }

    private val ready = ComputerVoice(online = true, installed = true, enabled = true)

    /** The controller runs in backgroundScope, which advanceUntilIdle doesn't wait for: step the clock instead. */
    private fun TestScope.settle() {
        testScheduler.advanceTimeBy(1_000)
        runCurrent()
    }

    private fun TestScope.controller(mic: MicHardware, caller: FakeCaller, choice: EngineChoice = EngineChoice.COMPUTER_FIRST) =
        DictationController(backgroundScope, caller, mic, { choice to "" }, { ready }, { "Mac" })

    @Test fun `each pause's words reach the box while listening goes on, in order`() = runTest {
        val words = ArrayDeque(listOf(" first part", " second part", " the tail"))
        val caller = FakeCaller { c -> if (c.channel == Channels.VOICE_TRANSCRIBE) JsonPrimitive(words.removeFirst()) else JsonPrimitive("") }
        val mic = StreamMic()
        val c = controller(mic, caller)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        runCurrent()
        assertTrue(c.state.value is MicState.Recording)
        assertTrue((c.state.value as MicState.Recording).continuous)

        mic.speak(1.0); mic.pause(1.5)
        runCurrent()
        assertEquals(listOf(" first part"), box)
        // Still listening: the first piece didn't end dictation.
        assertTrue(c.state.value is MicState.Recording)

        mic.speak(0.8); mic.pause(1.5)
        mic.speak(0.6) // Stop comes before this pause ends.
        runCurrent()
        assertEquals(listOf(" first part", " second part"), box)

        c.toggle(continuous = true) { box += it } // Stop
        settle()
        assertEquals(listOf(" first part", " second part", " the tail"), box)
        assertEquals(MicState.Idle, c.state.value)
        val sent = caller.calls.filter { it.channel == Channels.VOICE_TRANSCRIBE }
        assertEquals(3, sent.size)
        // Each piece is its own short WAV, not the whole recording.
        sent.forEach { assertTrue((it.args.single() as JsonArray).size < Wav.HEADER + Wav.SAMPLE_RATE * 2 * 3) }
        assertTrue(caller.calls.none { it.channel == Channels.CHAT_SEND })
    }

    @Test fun `a long stretch without a pause is cut at 30 s, so one piece fits a relay frame`() = runTest {
        val caller = FakeCaller { JsonPrimitive("words") }
        val mic = StreamMic()
        val c = controller(mic, caller)
        c.toggle(continuous = true) { }
        runCurrent()
        mic.speak(31.0)
        runCurrent()
        val first = caller.calls.first { it.channel == Channels.VOICE_TRANSCRIBE }
        assertEquals(Wav.HEADER + Wav.MAX_SAMPLES * 2, (first.args.single() as JsonArray).size)
        c.cancel()
    }

    @Test fun `pieces are transcribed one at a time, and Stop waits for the last`() = runTest {
        val gate = CompletableDeferred<Unit>()
        var inFlight = 0
        var most = 0
        val caller = FakeCaller { c ->
            if (c.channel != Channels.VOICE_TRANSCRIBE) return@FakeCaller JsonPrimitive("")
            inFlight++; most = maxOf(most, inFlight)
            gate.await()
            inFlight--
            JsonPrimitive("piece")
        }
        val mic = StreamMic()
        val c = controller(mic, caller)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        runCurrent()
        mic.speak(1.0); mic.pause(1.5); mic.speak(1.0); mic.pause(1.5)
        runCurrent()
        assertEquals(2, (c.state.value as MicState.Recording).transcribing)
        c.toggle(continuous = true) { } // Stop while pieces are still on their way.
        runCurrent()
        assertEquals(MicState.Transcribing(Engine.COMPUTER), c.state.value)
        gate.complete(Unit)
        settle()
        assertEquals(1, most)
        assertEquals(listOf("piece", "piece"), box)
        assertEquals(MicState.Idle, c.state.value)
    }

    @Test fun `a failing piece says so once and listening goes on`() = runTest {
        var n = 0
        val caller = FakeCaller { c ->
            if (c.channel != Channels.VOICE_TRANSCRIBE) return@FakeCaller JsonPrimitive("")
            n++
            if (n <= 2) throw IllegalStateException("Whisper is busy.") else JsonPrimitive("back again")
        }
        val mic = StreamMic()
        val c = controller(mic, caller)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        runCurrent()
        repeat(3) { mic.speak(1.0); mic.pause(1.5) }
        runCurrent()
        assertEquals("Couldn’t turn speech into text: Whisper is busy.", c.error.value)
        assertEquals(listOf("back again"), box)
        assertTrue(c.state.value is MicState.Recording)
        c.cancel()
    }

    @Test fun `cancel drops what is still on its way`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val caller = FakeCaller { gate.await(); JsonPrimitive("late words") }
        val mic = StreamMic()
        val c = controller(mic, caller)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        runCurrent()
        mic.speak(1.0); mic.pause(1.5)
        runCurrent()
        c.cancel()
        gate.complete(Unit)
        settle()
        assertTrue(box.isEmpty())
        assertEquals(MicState.Idle, c.state.value)
    }

    @Test fun `silence and whisper's non-speech tags type nothing`() = runTest {
        val caller = FakeCaller { JsonPrimitive("[BLANK_AUDIO]") }
        val mic = StreamMic()
        val c = controller(mic, caller)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        runCurrent()
        mic.pause(3.0) // Silence alone is never a piece.
        mic.speak(1.0); mic.pause(1.5)
        runCurrent()
        assertEquals(1, caller.calls.count { it.channel == Channels.VOICE_TRANSCRIBE })
        assertTrue(box.isEmpty())
        c.cancel()
    }

    @Test fun `the phone's recognizer listens again after each utterance until Stop`() = runTest {
        val mic = StreamMic().apply { phoneSays += listOf("one", "", "two") }
        val c = controller(mic, FakeCaller { JsonPrimitive("") }, choice = EngineChoice.PHONE)
        val box = mutableListOf<String>()
        c.toggle(continuous = true) { box += it }
        testScheduler.advanceTimeBy(DictationController.PHONE_RELISTEN_MS * 2 + 50)
        runCurrent()
        assertEquals(listOf("one", "two"), box)
        assertEquals(MicState.Recording(Engine.PHONE, 0, 0f, continuous = true), c.state.value)
        c.toggle(continuous = true) { box += it } // Stop
        settle()
        assertEquals(MicState.Idle, c.state.value)
        assertEquals(listOf("one", "two"), box)
    }

    @Test fun `tap mode's bar shows the time listened, with no cap`() {
        assertEquals("0:07", Dictation.elapsed(Wav.SAMPLE_RATE * 7))
        assertEquals("1:05", Dictation.elapsed(Wav.SAMPLE_RATE * 65))
        assertEquals("0:07 / 0:30", Dictation.clock(Wav.SAMPLE_RATE * 7))
    }

    @Test fun `segments go back to 16-bit PCM without wrapping`() {
        assertEquals(listOf<Short>(0, 32767, -32767, 32767, -32768), Wav.pcm(floatArrayOf(0f, 1f, -1f, 2f, -2f)).toList())
    }
}
