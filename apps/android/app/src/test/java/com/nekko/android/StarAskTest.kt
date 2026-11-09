package com.nekko.android

import com.nekko.android.chat.ChatController
import com.nekko.android.chat.ChatEnv
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.StarAsk
import com.nekko.android.data.StarAskState
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayState
import com.nekko.protocol.RemoteDefaults
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The star ask's rules, the same cases as packages/shared/src/support.test.ts. */
@OptIn(ExperimentalCoroutinesApi::class)
class StarAskTest {
    private fun after(n: Int, from: StarAskState = StarAskState()): StarAskState {
        var s = from
        repeat(n) { s = s.counted() }
        return s
    }

    @Test
    fun `the numbers are the desktop's`() = assertEquals(listOf(10, 50), StarAsk.AT)

    @Test
    fun `asks first after the 10th finished prompt, not before`() {
        assertFalse(after(9).due())
        assertTrue(after(10).due())
    }

    @Test
    fun `asks a second time at 50, then never again`() {
        val first = after(10).shown()
        assertFalse(after(39, first).due())
        val second = after(40, first)
        assertEquals(50, second.prompts)
        assertTrue(second.due())
        assertFalse(after(500, second.shown()).due())
    }

    @Test
    fun `over 120 prompts the store asks under exactly the 10th and the 50th reply`() {
        val store = MapPrefStore()
        val ask = StarAsk(PhonePrefs(store))
        val asked = (1..120).filter { ask.afterReply() }
        assertEquals(listOf(10, 50), asked)
        assertEquals(StarAskState(prompts = 120, asked = 2), ask.read())
        // Kept for the next launch.
        assertEquals(StarAskState(prompts = 120, asked = 2), StarAsk(PhonePrefs(store)).read())
    }

    @Test
    fun `never shows both asks back to back when the first comes late`() {
        val late = after(60).shown()
        assertEquals(2, late.asked)
        assertFalse(after(1, late).due())
    }

    @Test
    fun `stops for good on a star or Don't ask again`() {
        assertFalse(after(10).stop().due())
        assertFalse(after(40, after(10).shown().stop()).due())

        val ask = StarAsk(PhonePrefs(MapPrefStore()))
        repeat(10) { ask.afterReply() }
        ask.stop()
        assertTrue((1..200).none { ask.afterReply() })
        assertTrue(ask.read().stopped)
    }

    @Test
    fun `reads stored state defensively`() {
        assertEquals(StarAskState(), StarAskState.decode(null))
        assertEquals(StarAskState(), StarAskState.decode(""))
        assertEquals(StarAskState(), StarAskState.decode("not json"))
        assertEquals(StarAskState(), StarAskState.decode("[1,2]"))
        assertEquals(StarAskState(), StarAskState.decode("""{"prompts":-3,"asked":"2","stopped":"yes"}"""))
        assertEquals(StarAskState(12, 1, true), StarAskState.decode("""{"prompts":12.7,"asked":1,"stopped":true}"""))
        // A broken stored value starts over rather than failing the chat.
        assertEquals(StarAskState(), StarAsk(PhonePrefs(MapPrefStore(mutableMapOf("star_ask" to "{")))).read())
    }

    @Test
    fun `stores the desktop's JSON`() {
        assertEquals("""{"prompts":10,"asked":1}""", StarAskState(10, 1).encode())
        assertEquals("""{"prompts":3,"asked":0,"stopped":true}""", StarAskState(3, 0, true).encode())
        assertEquals(StarAskState(3, 0, true), StarAskState.decode(StarAskState(3, 0, true).encode()))
    }

    @Test
    fun `no prefs means no ask`() = assertNull(StarAsk.forApp(null))

    // ---- what counts: a prompt sent here whose reply finishes ----

    private val sid = "s1"
    private val online = ChatEnv(RelayState.ONLINE, null, RemoteDefaults("openai", "gpt-x"), "Mac")

    @Test
    fun `only a prompt sent here with a finished reply counts`() = runTest {
        var replied = 0
        val turnEnd = CompletableDeferred<JsonElement>()
        val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_SEND) turnEnd.await() else JsonNull }
        val chat = ChatController(sid, caller, backgroundScope, { online }, now = { 42L }, newId = { "m1" }, onPromptReplied = { replied++ })

        // A turn this phone didn't start (the computer, an automation, a queued prompt): not counted.
        chat.onEvent(AgentEvent.Done(sid, null))
        assertEquals(0, replied)

        chat.send("hello")
        runCurrent()
        // Another chat's done is not this reply.
        chat.onEvent(AgentEvent.Done("other", null))
        assertEquals(0, replied)
        chat.onEvent(AgentEvent.Done(sid, "a1"))
        assertEquals(1, replied)
        // Counted once, even if the computer says done again.
        chat.onEvent(AgentEvent.Done(sid, "a1"))
        assertEquals(1, replied)
    }

    @Test
    fun `a failed or stopped reply never counts`() = runTest {
        var replied = 0
        val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_SEND) CompletableDeferred<JsonElement>().await() else JsonNull }
        val chat = ChatController(sid, caller, backgroundScope, { online }, now = { 42L }, newId = { "m1" }, onPromptReplied = { replied++ })

        for (end in listOf("boom", "Stopped")) {
            chat.send("hello")
            runCurrent()
            chat.onEvent(AgentEvent.Error(sid, end))
            chat.onEvent(AgentEvent.Done(sid, null))
        }
        assertEquals(0, replied)
    }

    @Test
    fun `a prompt queued during a run does not count`() = runTest {
        var replied = 0
        val caller = FakeCaller { c -> if (c.channel == Channels.CHAT_SEND) CompletableDeferred<JsonElement>().await() else JsonNull }
        val chat = ChatController(sid, caller, backgroundScope, { online }, now = { 42L }, newId = { "m1" }, onPromptReplied = { replied++ })
        // The computer is already running a reply here (started elsewhere).
        chat.onEvent(AgentEvent.Text(sid, "working"))
        assertTrue(chat.state.value.turn.running)
        chat.send("and then this")
        runCurrent()
        assertEquals(listOf(Channels.CHAT_QUEUE), caller.channels())
        chat.onEvent(AgentEvent.Done(sid, null))
        assertEquals(0, replied)
    }
}
