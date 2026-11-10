package com.nekko.android.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceConversationTest {
    private class Late<T> {
        lateinit var continuation: Continuation<T>
        suspend fun await(): T = suspendCoroutine { continuation = it }
        fun complete(value: T) = continuation.resume(value)
    }

    @Test fun `explicit start cycles capture respond speak capture without overlap`() = runTest {
        val captured = CompletableDeferred<String>()
        val replied = CompletableDeferred<String>()
        val spoken = CompletableDeferred<Unit>()
        val events = mutableListOf<String>()
        var captures = 0
        val c = VoiceConversation(backgroundScope)
        assertFalse(c.state.value.active)
        c.start(VoiceConversation.IO(
            capture = { events += "capture"; if (++captures == 1) captured.await() else CompletableDeferred<String>().await() },
            respond = { events += "respond:$it"; replied.await() },
            speak = { events += "speak:$it"; spoken.await() }, stopAudio = { events += "stop" },
        ))
        runCurrent()
        assertEquals(listOf("capture"), events)
        assertEquals(VoiceConversation.Phase.LISTENING, c.state.value.phase)
        captured.complete("  Hello  "); runCurrent()
        assertEquals(VoiceConversation.Phase.WAITING, c.state.value.phase)
        replied.complete("**Hello** [world](https://example.org)"); runCurrent()
        assertEquals(VoiceConversation.Phase.SPEAKING, c.state.value.phase)
        assertEquals(listOf("capture", "respond:Hello", "speak:Hello world"), events)
        spoken.complete(Unit); runCurrent()
        assertEquals(2, captures)
        c.stop(); runCurrent()
        assertFalse(c.state.value.active)
        assertEquals(1, events.count { it == "stop" })
    }

    @Test fun `duplicate start and stop before dispatch never opens microphone`() = runTest {
        var captures = 0
        var stops = 0
        val c = VoiceConversation(backgroundScope)
        val io = VoiceConversation.IO({ captures++; "hi" }, { "answer" }, {}, { stops++ })
        c.start(io); c.start(io); c.stop(); runCurrent()
        assertEquals(0, captures)
        assertEquals(1, stops)
        assertFalse(c.state.value.active)
    }

    @Test fun `late capture after stop cannot send or stop a newer run`() = runTest {
        val late = Late<String>()
        var sends = 0
        var stops = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ late.await() }, { sends++; "answer" }, {}, { stops++ }))
        runCurrent(); c.stop()
        c.start(VoiceConversation.IO({ CompletableDeferred<String>().await() }, { sends++; "answer" }, {}, { stops++ }))
        runCurrent(); late.complete("stale"); runCurrent()
        assertEquals(0, sends)
        assertEquals(1, stops)
        assertTrue(c.state.value.active)
        assertEquals("", c.state.value.heard)
        c.stop()
    }

    @Test fun `late response after safety exit cannot speak or listen again`() = runTest {
        val response = Late<String>()
        var captures = 0
        var speaks = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ captures++; "hi" }, { response.await() }, { speaks++ }, {}))
        runCurrent(); assertEquals(VoiceConversation.Phase.WAITING, c.state.value.phase)
        c.safetyChanged(false); response.complete("stale"); runCurrent()
        assertEquals(0, speaks); assertEquals(1, captures)
        c.safetyChanged(true); runCurrent()
        assertFalse(c.state.value.active)
    }

    @Test fun `late playback completion cannot restart microphone`() = runTest {
        val speech = Late<Unit>()
        var captures = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ captures++; "hi" }, { "reply" }, { speech.await() }, {}))
        runCurrent(); c.stop(); speech.complete(Unit); runCurrent()
        assertEquals(1, captures)
        assertFalse(c.state.value.active)
    }

    @Test fun `authorization is rechecked after noncooperative capture`() = runTest {
        val captured = Late<String>()
        var allowed = true
        var sends = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ captured.await() }, { sends++; "reply" }, {}, {}, { allowed }))
        runCurrent(); allowed = false; captured.complete("hi"); runCurrent()
        assertEquals(0, sends)
        assertFalse(c.state.value.active)
        assertNotNull(c.state.value.error)
    }

    @Test fun `silence and transport error stop rather than retry or send empty words`() = runTest {
        var sends = 0
        var speaks = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ "  " }, { sends++; "reply" }, { speaks++ }, {})); runCurrent()
        assertEquals(0, sends); assertNotNull(c.state.value.error)
        c.start(VoiceConversation.IO({ "hi" }, { sends++; error("Disconnected") }, { speaks++ }, {})); runCurrent()
        assertEquals(1, sends); assertEquals(0, speaks)
        assertEquals("Disconnected", c.state.value.error)
        assertFalse(c.state.value.active)
    }

    @Test fun `empty reply does not cause an unacknowledged next turn`() = runTest {
        var captures = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ captures++; "hi" }, { "  " }, { fail("must not speak") }, {})); runCurrent()
        assertEquals(1, captures); assertNotNull(c.state.value.error)
        assertFalse(c.state.value.active)
    }

    @Test fun `capture timeout and scope disposal stop audio`() = runTest {
        var stops = 0
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ CompletableDeferred<String>().await() }, { "reply" }, {}, { stops++ }))
        runCurrent(); advanceTimeBy(VoiceConversation.CAPTURE_TIMEOUT_MS); runCurrent()
        assertFalse(c.state.value.active); assertNotNull(c.state.value.error); assertEquals(1, stops)
        val owner = CoroutineScope(coroutineContext + Job())
        val owned = VoiceConversation(owner)
        owned.start(VoiceConversation.IO({ CompletableDeferred<String>().await() }, { "reply" }, {}, { stops++ }))
        runCurrent(); owner.cancel(); runCurrent()
        assertEquals(2, stops); assertFalse(owned.state.value.active)
    }

    @Test fun `disallowed initial state never invokes hardware`() = runTest {
        val c = VoiceConversation(backgroundScope)
        c.start(VoiceConversation.IO({ fail("capture"); "" }, { "" }, {}, {}, { false }))
        runCurrent(); assertFalse(c.state.value.active); assertNotNull(c.state.value.error)
    }
}
