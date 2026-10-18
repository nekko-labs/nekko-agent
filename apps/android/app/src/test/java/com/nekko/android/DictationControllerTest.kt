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
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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

    private val ready = ComputerVoice(online = true, installed = true, enabled = true)

    private fun TestScope.controller(
        mic: FakeMic,
        caller: FakeCaller,
        choice: EngineChoice = EngineChoice.COMPUTER_FIRST,
        pc: ComputerVoice = ready,
    ) = DictationController(backgroundScope, caller, mic, { choice to "" }, { pc }, { "Mac" })

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
    fun `computer voice asks voice-status only when online`() = runTest {
        val caller = FakeCaller { JsonPrimitive("") }
        assertEquals(ComputerVoice.UNKNOWN, DictationController.computerVoice(caller, online = false, enabled = true))
        assertTrue(caller.calls.isEmpty())
        val installed = FakeCaller { kotlinx.serialization.json.buildJsonObject { put("installed", JsonPrimitive(true)) } }
        assertEquals(ready, DictationController.computerVoice(installed, online = true, enabled = true))
    }
}
