package com.nekko.android.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceListeningTest {
    private class Host : VoiceRunner.Host {
        override var text = ""
        override suspend fun send() = true
    }
    @Test fun `continuous mode ignores silence then dictates each final result until explicit abort`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        var count = 0
        var stopped = 0
        listening.start(VoiceListening.IO({ when (++count) { 1 -> ""; 2 -> "hello"; else -> CompletableDeferred<String>().await() } }, {}, { stopped++ }))
        runCurrent(); assertEquals(1, count)
        advanceTimeBy(201); runCurrent(); assertEquals("hello", host.text)
        advanceTimeBy(201); runCurrent(); assertEquals(3, count)
        listening.abort(); runCurrent()
        assertFalse(listening.state.value.active); assertEquals(1, stopped)
    }
    @Test fun `normal hold finish drains final words and retains a confirmation for next hold`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        val captured = CompletableDeferred<String>()
        listening.start(VoiceListening.IO({ captured.await() }, { captured.complete("Nekko complete this session") }, {}), held = true)
        runCurrent(); listening.finish(); runCurrent()
        assertFalse(listening.state.value.active)
        assertNotNull(runner.pending.value)
    }
    @Test fun `held endpoint cannot execute until physical release and abort discards it`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        listening.start(VoiceListening.IO({ "Nekko complete this session" }, {}, {}), held = true)
        runCurrent(); assertNull(runner.pending.value); assertTrue(listening.state.value.active)
        listening.finish(); runCurrent()
        assertNotNull(runner.pending.value); assertFalse(listening.state.value.active)
        listening.start(VoiceListening.IO({ "new words" }, {}, {}), held = true)
        runCurrent(); assertEquals("", host.text)
        listening.abort(); runCurrent()
        assertEquals("", host.text); assertNull(runner.pending.value)
    }
    @Test fun `abort of noncooperative capture discards text and does not stop newer audio`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        lateinit var late: Continuation<String>
        var stopped = 0
        listening.start(VoiceListening.IO({ suspendCoroutine { late = it } }, {}, { stopped++ }))
        runCurrent(); listening.abort()
        listening.start(VoiceListening.IO({ CompletableDeferred<String>().await() }, {}, { stopped++ }))
        runCurrent(); late.resume("stale words"); runCurrent()
        assertEquals("", host.text); assertEquals(1, stopped); assertTrue(listening.state.value.active)
        listening.abort()
    }
    @Test fun `finish in restart gap cannot open another recognizer`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        var captures = 0
        listening.start(VoiceListening.IO({ captures++; "hello" }, {}, {}))
        runCurrent(); listening.finish(); advanceTimeBy(201); runCurrent()
        assertEquals(1, captures); assertFalse(listening.state.value.active)
    }
    @Test fun `startup is reserved and disallowed startup does not open hardware`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        var captures = 0
        val io = VoiceListening.IO({ captures++; CompletableDeferred<String>().await() }, {}, {})
        listening.start(io.copy(allowed = { false })); runCurrent(); assertEquals(0, captures)
        listening.start(io); listening.start(io); runCurrent(); assertEquals(1, captures)
        listening.abort()
    }
    @Test fun `normal finish before first dispatch never opens microphone`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        var captures = 0
        var stops = 0
        listening.start(VoiceListening.IO({ captures++; "stale" }, {}, { stops++ }))
        listening.finish(); runCurrent()
        assertEquals(0, captures); assertEquals(1, stops)
        assertEquals("", host.text); assertFalse(listening.state.value.active)
    }
    @Test fun `timeout stops instead of indefinitely restarting microphone`() = runTest {
        val host = Host(); val runner = VoiceRunner(backgroundScope, host)
        val listening = VoiceListening(backgroundScope, runner)
        listening.start(VoiceListening.IO({ CompletableDeferred<String>().await() }, {}, {}))
        runCurrent(); advanceTimeBy(VoiceConversation.CAPTURE_TIMEOUT_MS + 1); runCurrent()
        assertFalse(listening.state.value.active); assertNotNull(listening.state.value.error)
    }
}
