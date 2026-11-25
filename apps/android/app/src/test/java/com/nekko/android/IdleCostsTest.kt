package com.nekko.android

import com.nekko.android.computer.MachineController
import com.nekko.android.data.CachedKey
import com.nekko.android.data.ComputersState
import com.nekko.android.data.withAgentEvent
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Channels
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test
import javax.crypto.spec.SecretKeySpec

@OptIn(ExperimentalCoroutinesApi::class)
class IdleCostsTest {
    @Test
    fun `the Keystore key is opened once, and again only after a use of it failed`() {
        var opens = 0
        val key = CachedKey { opens++; SecretKeySpec(ByteArray(32) { opens.toByte() }, "AES") }
        val first = key.get()
        repeat(20) { assertSame(first, key.get()) }
        assertEquals(1, opens)
        key.forget()
        assertNotSame(first, key.get())
        assertEquals(2, opens)
    }

    @Test
    fun `a streamed token leaves the computers state as it was`() {
        val s = ComputersState()
        val running = withAgentEvent(s, AgentEvent.Text("s1", "a"))
        assertEquals(Activity.RUNNING, running.activity["s1"])
        // Later words of the same reply change nothing: the very same state, no copy.
        assertSame(running, withAgentEvent(running, AgentEvent.Text("s1", "b")))
        assertSame(running, withAgentEvent(running, AgentEvent.Reasoning("s1", "c")))
        // A change still gets through, and an end clears it.
        val other = withAgentEvent(running, AgentEvent.Text("s2", "x"))
        assertEquals(mapOf("s1" to Activity.RUNNING, "s2" to Activity.RUNNING), other.activity)
        assertEquals(mapOf("s2" to Activity.RUNNING), withAgentEvent(other, AgentEvent.Done("s1", null)).activity)
    }

    @Test
    fun `the computer page reads every 30 s only while its coroutine lives`() = runTest {
        val caller = FakeCaller { c -> if (c.channel == Channels.APP_INFO) JsonNull else JsonNull }
        val machine = MachineController(caller, backgroundScope, reachable = { true }, loadModels = {})
        val job = launch { machine.poll() }
        runCurrent()
        val first = caller.calls.count { it.channel == Channels.APP_INFO }
        assertEquals(1, first)
        advanceTimeBy(30_001)
        assertEquals(2, caller.calls.count { it.channel == Channels.APP_INFO })
        // The screen stopped (repeatOnLifecycle cancelled it): no more reads while it is away.
        job.cancel()
        advanceTimeBy(300_000)
        assertEquals(2, caller.calls.count { it.channel == Channels.APP_INFO })
    }
}
