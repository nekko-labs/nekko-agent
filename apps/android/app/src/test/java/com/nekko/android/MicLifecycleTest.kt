package com.nekko.android

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.nekko.android.lock.AppLock
import com.nekko.android.ui.screens.observeMicLifecycle
import com.nekko.android.voice.ComputerVoice
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.EngineChoice
import com.nekko.android.voice.MicHardware
import com.nekko.android.voice.MicState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MicLifecycleTest {
    private class Owner : LifecycleOwner {
        override val lifecycle = LifecycleRegistry.createUnsafe(this)
    }

    private class Mic : MicHardware {
        var starts = 0
        var stops = 0
        override suspend fun record(onProgress: (Int, Float) -> Unit): ShortArray {
            starts++
            return CompletableDeferred<ShortArray>().await()
        }
        override fun stopRecording() { stops++ }
        override fun phoneAvailable() = false
        override suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String = error("No phone fallback")
        override fun stopPhone() = Unit
    }

    private fun TestScope.controller(mic: Mic) = DictationController(
        backgroundScope, FakeCaller(), mic, { EngineChoice.COMPUTER_ONLY to "" },
        { ComputerVoice(online = true, installed = true, enabled = true) }, { "Mac" },
    )

    @Test
    fun `ON_STOP cancels without disposal or app lock and resume does not restart`() = runTest {
        val owner = Owner().apply { lifecycle.currentState = Lifecycle.State.STARTED }
        val mic = Mic()
        val d = controller(mic)
        var pending = true
        val dispose = observeMicLifecycle(d, owner.lifecycle, null, backgroundScope) { pending = false }
        d.toggle { error("Must not insert text") }
        runCurrent()
        assertEquals(1, mic.starts)
        owner.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertEquals(MicState.Idle, d.state.value)
        assertTrue(!pending)
        assertEquals(1, mic.stops)
        owner.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        assertEquals(1, mic.starts)
        dispose()
    }

    @Test
    fun `app lock cancels a still STARTED composed chat independently of ON_STOP`() = runTest {
        val owner = Owner().apply { lifecycle.currentState = Lifecycle.State.STARTED }
        val lock = AppLock(enabled = true).apply { unlock() }
        val mic = Mic()
        val d = controller(mic)
        var pending = true
        val dispose = observeMicLifecycle(d, owner.lifecycle, lock, backgroundScope) { pending = false }
        d.toggle { error("Must not insert text") }
        runCurrent()
        lock.onBackground()
        runCurrent()
        assertEquals(Lifecycle.State.STARTED, owner.lifecycle.currentState)
        assertEquals(MicState.Idle, d.state.value)
        assertTrue(!pending)
        assertEquals(1, mic.stops)
        lock.unlock()
        runCurrent()
        assertEquals(1, mic.starts)
        dispose()
    }

    @Test
    fun `lock is observed while stopped and disposal removes both subscriptions`() = runTest {
        val owner = Owner().apply { lifecycle.currentState = Lifecycle.State.STARTED }
        val lock = AppLock(enabled = true).apply { unlock() }
        val mic = Mic()
        val d = controller(mic)
        var clears = 0
        val dispose = observeMicLifecycle(d, owner.lifecycle, lock, backgroundScope) { clears++ }
        owner.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertEquals(1, clears)
        lock.onBackground()
        runCurrent()
        assertEquals(2, clears)
        dispose()
        val stopped = mic.stops
        val cleared = clears
        lock.unlock()
        runCurrent()
        owner.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_START)
        owner.lifecycle.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        lock.onBackground()
        runCurrent()
        assertEquals(stopped, mic.stops)
        assertEquals(cleared, clears)
    }

    @Test
    fun `an initially locked chat cancels an existing probe before hardware starts`() = runTest {
        val owner = Owner().apply { lifecycle.currentState = Lifecycle.State.STARTED }
        val lock = AppLock(enabled = true)
        val probe = CompletableDeferred<ComputerVoice>()
        val mic = Mic()
        val d = DictationController(
            backgroundScope, FakeCaller(), mic, { EngineChoice.COMPUTER_ONLY to "" },
            { probe.await() }, { "Mac" },
        )
        d.toggle { error("Must not insert text") }
        runCurrent()
        var pending = true
        val dispose = observeMicLifecycle(d, owner.lifecycle, lock, backgroundScope) { pending = false }
        probe.complete(ComputerVoice(online = true, installed = true, enabled = true))
        runCurrent()
        assertEquals(0, mic.starts)
        assertTrue(!pending)
        assertEquals(MicState.Idle, d.state.value)
        dispose()
    }
}
