package com.nekko.android

import com.nekko.android.voice.ComputerVoice
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.Engine
import com.nekko.android.voice.EngineChoice
import com.nekko.android.voice.MicHardware
import com.nekko.android.voice.MicState
import com.nekko.android.voice.Wav
import com.nekko.protocol.Channels
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

@OptIn(ExperimentalCoroutinesApi::class)
class DictationControllerTest {
    private class FakeMic(var phone: Boolean = true, var phoneSays: String = "from the phone") : MicHardware {
        val recorded = CompletableDeferred<ShortArray>()
        var phoneCalls = 0
        override suspend fun record(onProgress: (Int, Float) -> Unit): ShortArray {
            onProgress(8_000, 0.5f)
            return recorded.await()
        }
        override fun stopRecording() {
            if (!recorded.isCompleted) recorded.complete(ShortArray(Wav.SAMPLE_RATE * 2))
        }
        override fun phoneAvailable() = phone
        override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String {
            phoneCalls++
            return phoneSays
        }
        override fun stopPhone() = Unit
    }

    /** A platform callback that deliberately ignores Job cancellation. */
    private class LateResult<T> {
        private lateinit var continuation: Continuation<T>
        suspend fun await(): T = suspendCoroutine { continuation = it }
        fun complete(value: T) = continuation.resume(value)
        fun fail(error: Exception) = continuation.resumeWithException(error)
    }

    private class LateMic : MicHardware {
        class Recording(val progress: (Int, Float) -> Unit, val result: LateResult<ShortArray> = LateResult())
        class Listening(val level: (Float) -> Unit, val result: LateResult<String> = LateResult())
        val recordings = mutableListOf<Recording>()
        val listeners = mutableListOf<Listening>()
        override suspend fun record(onProgress: (Int, Float) -> Unit): ShortArray {
            val recording = Recording(onProgress).also { recordings += it }
            onProgress(8_000, 0.5f)
            return recording.result.await()
        }
        override fun stopRecording() = Unit
        override fun phoneAvailable() = true
        override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String {
            val listening = Listening(onLevel).also { listeners += it }
            return listening.result.await()
        }
        override fun stopPhone() = Unit
    }

    private val ready = ComputerVoice(online = true, installed = true, enabled = true)

    private fun TestScope.controller(
        mic: MicHardware,
        caller: FakeCaller,
        choice: EngineChoice = EngineChoice.COMPUTER_FIRST,
        pc: ComputerVoice = ready,
        probe: suspend () -> ComputerVoice = { pc },
    ) = DictationController(backgroundScope, caller, mic, { choice to "" }, probe, { "Mac" })

    @Test
    fun `computer engine records, sends the WAV to voice-transcribe, and fills the box, never sends`() = runTest {
        val caller = FakeCaller { c -> if (c.channel == Channels.VOICE_TRANSCRIBE) JsonPrimitive(" summarise the diff") else JsonPrimitive("") }
        val mic = FakeMic()
        val c = controller(mic, caller)
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        assertEquals(MicState.Recording(Engine.COMPUTER, 8_000, 0.5f), c.state.value)
        c.toggle { box = it } // stop
        runCurrent()
        assertEquals(" summarise the diff", box)
        assertEquals(MicState.Idle, c.state.value)
        val sent = caller.calls.single { it.channel == Channels.VOICE_TRANSCRIBE }
        assertEquals(300_000L, sent.timeoutMs)
        assertTrue(DictationController.TRANSCRIBE_TIMEOUT_MS > 105_000L + 120_000L)
        val wav = (sent.args.single() as JsonArray)
        assertEquals(Wav.HEADER + Wav.SAMPLE_RATE * 2 * 2, wav.size)
        assertEquals(82, (wav[0] as JsonPrimitive).content.toInt()) // 'R'
        assertTrue(caller.calls.none { it.channel == Channels.CHAT_SEND })
        assertEquals(0, mic.phoneCalls)
    }

    @Test
    fun `computer not ready falls back to the phone under computer first`() = runTest {
        val caller = FakeCaller { JsonPrimitive("") }
        val mic = FakeMic()
        val c = controller(mic, caller, pc = ready.copy(installed = false))
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        assertEquals("from the phone", box)
        assertTrue(caller.calls.none { it.channel == Channels.VOICE_TRANSCRIBE })
    }

    @Test
    fun `computer only says why instead of using the phone`() = runTest {
        val mic = FakeMic()
        val c = controller(mic, FakeCaller { JsonPrimitive("") }, choice = EngineChoice.COMPUTER_ONLY, pc = ready.copy(enabled = false))
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        assertNull(box)
        assertEquals(0, mic.phoneCalls)
        assertEquals("Nekko Voice is turned off on Mac (Settings → Nekko Voice there).", c.error.value)
    }

    @Test
    fun `a tap-length recording is not sent`() = runTest {
        val caller = FakeCaller { JsonPrimitive("x") }
        val mic = FakeMic()
        val c = controller(mic, caller)
        c.toggle { }
        runCurrent()
        mic.recorded.complete(ShortArray(100))
        runCurrent()
        assertTrue(caller.calls.none { it.channel == Channels.VOICE_TRANSCRIBE })
        assertEquals("That was too short. Hold on a moment longer.", c.error.value)
    }

    @Test
    fun `the computer's error is shown as is`() = runTest {
        val caller = FakeCaller { throw IllegalStateException("Download Nekko Voice first.") }
        val mic = FakeMic()
        val c = controller(mic, caller)
        c.toggle { }
        runCurrent()
        c.toggle { }
        runCurrent()
        assertEquals("Download Nekko Voice first.", c.error.value)
        assertEquals(MicState.Idle, c.state.value)
    }

    @Test
    fun `nothing heard is a gentle error, not empty text in the box`() = runTest {
        val mic = FakeMic(phoneSays = "")
        val c = controller(mic, FakeCaller { JsonPrimitive("") }, choice = EngineChoice.PHONE)
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        assertNull(box)
        assertEquals("Didn’t catch anything. Try again a little closer to the phone.", c.error.value)
    }

    @Test
    fun `whisper's blank-audio marker is nothing heard, not text`() = runTest {
        val caller = FakeCaller { c -> if (c.channel == Channels.VOICE_TRANSCRIBE) JsonPrimitive("[BLANK_AUDIO]") else JsonPrimitive("") }
        val mic = FakeMic()
        val c = controller(mic, caller)
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        c.toggle { box = it }
        runCurrent()
        assertNull(box)
        assertEquals("Didn’t catch anything. Try again a little closer to the phone.", c.error.value)
    }

    @Test
    fun `cancel during startup cannot start microphone even when status swallows cancellation`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val mic = FakeMic()
        val c = DictationController(backgroundScope, FakeCaller { JsonPrimitive("") }, mic,
            { EngineChoice.COMPUTER_FIRST to "" },
            { runCatching { gate.await() }; ready }, { "Mac" })
        var heard: String? = null
        c.toggle { heard = it }
        runCurrent()
        c.cancel()
        gate.complete(Unit)
        runCurrent()
        assertEquals(0, mic.phoneCalls)
        assertNull(heard)
        assertEquals(MicState.Idle, c.state.value)
    }

    @Test
    fun `cancel discards a late noncancellable phone result`() = runTest {
        val gate = CompletableDeferred<String>()
        val mic = object : MicHardware {
            override suspend fun record(onProgress: (Int, Float) -> Unit) = ShortArray(0)
            override fun stopRecording() = Unit
            override fun phoneAvailable() = true
            override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String =
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() }
            override fun stopPhone() = Unit
        }
        val c = DictationController(backgroundScope, FakeCaller { JsonPrimitive("") }, mic,
            { EngineChoice.PHONE to "" }, { ready }, { "Mac" })
        var heard: String? = null
        c.toggle { heard = it }
        runCurrent()
        c.cancel()
        gate.complete("send to secret saying late words")
        runCurrent()
        assertNull(heard)
        assertEquals(MicState.Idle, c.state.value)
    }

    @Test
    fun `a regular phone stop still keeps the recognized text`() = runTest {
        val spoken = CompletableDeferred<String>()
        val mic = object : MicHardware {
            override suspend fun record(onProgress: (Int, Float) -> Unit): ShortArray = error("No computer recording")
            override fun stopRecording() = Unit
            override fun phoneAvailable() = true
            override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String {
                onLevel(0.5f)
                return spoken.await()
            }
            override fun stopPhone() { spoken.complete("keep this text") }
        }
        val caller = FakeCaller()
        val c = controller(mic, caller, choice = EngineChoice.PHONE)
        var box: String? = null
        c.toggle { box = it }
        runCurrent()
        assertEquals(MicState.Recording(Engine.PHONE, 0, 0.5f), c.state.value)
        c.toggle { box = it }
        runCurrent()
        assertEquals("keep this text", box)
        assertEquals(MicState.Idle, c.state.value)
        assertTrue(caller.calls.isEmpty())
    }

    @Test
    fun `repeated taps reserve one job before dispatch and while the probe is pending`() = runTest {
        val probe = CompletableDeferred<ComputerVoice>()
        var probes = 0
        val mic = LateMic()
        val c = controller(mic, FakeCaller()) { probes++; probe.await() }
        c.toggle { }
        c.toggle { }
        runCurrent()
        assertEquals(1, probes)
        assertEquals(MicState.Idle, c.state.value)
        c.toggle { }
        c.toggle { }
        runCurrent()
        assertEquals(1, probes)
        assertTrue(mic.recordings.isEmpty())
        probe.complete(ready)
        runCurrent()
        assertEquals(1, mic.recordings.size)
        c.cancel()
        mic.recordings.single().result.complete(ShortArray(0))
        runCurrent()
    }

    @Test
    fun `cancel before dispatch prevents a late start and allows a fresh tap`() = runTest {
        var probes = 0
        val mic = FakeMic()
        val c = controller(mic, FakeCaller()) { probes++; ready }
        c.toggle { }
        c.cancel()
        runCurrent()
        assertEquals(0, probes)
        assertEquals(MicState.Idle, c.state.value)
        c.toggle { }
        runCurrent()
        assertEquals(1, probes)
    }

    @Test
    fun `cancel while a cooperative probe awaits never starts hardware`() = runTest {
        val probe = CompletableDeferred<ComputerVoice>()
        val mic = LateMic()
        val caller = FakeCaller()
        val c = controller(mic, caller) { probe.await() }
        c.toggle { error("Must not insert text") }
        runCurrent()
        c.cancel()
        probe.complete(ready)
        runCurrent()
        assertTrue(mic.recordings.isEmpty())
        assertTrue(mic.listeners.isEmpty())
        assertTrue(caller.calls.isEmpty())
        assertEquals(MicState.Idle, c.state.value)
        assertNull(c.error.value)
    }

    @Test
    fun `a cancelled noncooperative probe cannot start hardware or clear a newer recording`() = runTest {
        for (lateError in listOf(false, true)) {
            val probe = LateResult<ComputerVoice>()
            var probes = 0
            val mic = LateMic()
            val c = controller(mic, FakeCaller()) { if (++probes == 1) probe.await() else ready }
            c.toggle { error("Must not insert stale text") }
            runCurrent()
            c.cancel()
            c.toggle { }
            runCurrent()
            val newer = c.state.value
            if (lateError) probe.fail(IllegalStateException("stale probe error")) else probe.complete(ready)
            runCurrent()
            assertEquals(1, mic.recordings.size)
            assertEquals(newer, c.state.value)
            assertNull(c.error.value)
            c.cancel()
            mic.recordings.single().result.complete(ShortArray(0))
            runCurrent()
        }
    }

    @Test
    fun `an old finally cannot release the job guard of a newer pending probe`() = runTest {
        val first = LateResult<ComputerVoice>()
        val second = CompletableDeferred<ComputerVoice>()
        var probes = 0
        val mic = LateMic()
        val c = controller(mic, FakeCaller()) { if (++probes == 1) first.await() else second.await() }
        c.toggle { }
        runCurrent()
        c.cancel()
        c.toggle { }
        runCurrent()
        first.complete(ready)
        runCurrent()
        c.toggle { }
        runCurrent()
        assertEquals(2, probes)
        assertEquals(MicState.Idle, c.state.value)
        second.complete(ready)
        runCurrent()
        assertEquals(1, mic.recordings.size)
        c.cancel()
        mic.recordings.single().result.complete(ShortArray(0))
        runCurrent()
    }

    @Test
    fun `cancelled record callbacks and completions cannot upload or overwrite a new run`() = runTest {
        for (size in listOf(0, Wav.SAMPLE_RATE * 2)) {
            val mic = LateMic()
            val caller = FakeCaller { JsonPrimitive("stale text") }
            val c = controller(mic, caller)
            c.toggle { error("Must not insert stale text") }
            runCurrent()
            val old = mic.recordings.single()
            c.cancel()
            c.toggle { }
            runCurrent()
            val newer = c.state.value
            old.progress(99_000, 1f)
            assertEquals(newer, c.state.value)
            old.result.complete(ShortArray(size))
            runCurrent()
            assertTrue(caller.calls.isEmpty())
            assertNull(c.error.value)
            assertEquals(newer, c.state.value)
            c.cancel()
            mic.recordings.last().result.complete(ShortArray(0))
            runCurrent()
        }
    }

    @Test
    fun `late record progress cannot turn transcribing back into recording`() = runTest {
        val mic = LateMic()
        val transcription = CompletableDeferred<JsonElement>()
        val c = controller(mic, FakeCaller { transcription.await() })
        c.toggle { }
        runCurrent()
        val recording = mic.recordings.single()
        recording.result.complete(ShortArray(Wav.SAMPLE_RATE * 2))
        runCurrent()
        recording.progress(99_000, 1f)
        assertEquals(MicState.Transcribing(Engine.COMPUTER), c.state.value)
        c.cancel()
        runCurrent()
    }

    @Test
    fun `cancelled transcription results and errors cannot insert text or reset a newer run`() = runTest {
        for (lateError in listOf(false, true)) {
            val mic = LateMic()
            val transcription = LateResult<JsonElement>()
            val caller = FakeCaller { transcription.await() }
            val c = controller(mic, caller)
            val box = mutableListOf<String>()
            c.toggle { box += it }
            runCurrent()
            mic.recordings.single().result.complete(ShortArray(Wav.SAMPLE_RATE * 2))
            runCurrent()
            assertEquals(MicState.Transcribing(Engine.COMPUTER), c.state.value)
            c.cancel()
            c.toggle { box += it }
            runCurrent()
            val newer = c.state.value
            if (lateError) transcription.fail(IllegalStateException("stale transcription error"))
            else transcription.complete(JsonPrimitive("stale text"))
            runCurrent()
            assertTrue(box.isEmpty())
            assertNull(c.error.value)
            assertEquals(newer, c.state.value)
            assertEquals(1, caller.calls.size)
            c.cancel()
            mic.recordings.last().result.complete(ShortArray(0))
            runCurrent()
        }
    }

    @Test
    fun `cancelled phone callbacks results and errors cannot affect a newer phone run`() = runTest {
        for (lateError in listOf(false, true)) {
            val mic = LateMic()
            val c = controller(mic, FakeCaller(), choice = EngineChoice.PHONE)
            val box = mutableListOf<String>()
            c.toggle { box += it }
            runCurrent()
            val old = mic.listeners.single()
            c.cancel()
            c.toggle { box += it }
            runCurrent()
            val newer = c.state.value
            old.level(1f)
            assertEquals(newer, c.state.value)
            if (lateError) old.result.fail(IllegalStateException("stale phone error")) else old.result.complete("stale text")
            runCurrent()
            assertTrue(box.isEmpty())
            assertNull(c.error.value)
            assertEquals(newer, c.state.value)
            c.cancel()
            mic.listeners.last().result.complete("")
            runCurrent()
        }
    }

    @Test
    fun `computer voice propagates cancellation rather than falling back to the phone`() = runTest {
        val caller = FakeCaller { throw CancellationException("cancelled status") }
        val error = runCatching { DictationController.computerVoice(caller, online = true, enabled = true) }.exceptionOrNull()
        assertTrue(error is CancellationException)
    }

    @Test
    fun `computer voice asks voice-status only when online`() = runTest {
        val caller = FakeCaller { JsonPrimitive("") }
        assertEquals(ComputerVoice.UNKNOWN, DictationController.computerVoice(caller, online = false, enabled = true))
        assertTrue(caller.calls.isEmpty())
        val installed = FakeCaller { kotlinx.serialization.json.buildJsonObject { put("installed", JsonPrimitive(true)) } }
        assertEquals(ready, DictationController.computerVoice(installed, online = true, enabled = true))
    }
}
