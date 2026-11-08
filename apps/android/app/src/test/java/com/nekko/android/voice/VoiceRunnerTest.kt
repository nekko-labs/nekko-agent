package com.nekko.android.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceRunnerTest {
    private open class Host : VoiceRunner.Host {
        override var text = ""
        var safe = true
        val events = mutableListOf<String>()
        var availableChats = emptyList<VoiceRunner.Chat>()
        var facts = VoiceRunner.ShipFacts()
        override fun allowed() = safe
        override suspend fun send(): Boolean { events += "send:$text"; text = ""; return true }
        override fun toast(text: String) { events += "toast:$text" }
        override fun open(id: String) { events += "open:$id" }
        override fun park(text: String) { events += "park:$text" }
        override fun newChat() { events += "new" }
        override fun openSettings() { events += "settings" }
        override fun chats() = availableChats
        override fun status() = "Working"
        override suspend fun complete() { events += "complete" }
        override suspend fun ship() = facts
        override suspend fun merge(pr: VoiceRunner.PullRequest): String? { events += "merge:${pr.id}"; return null }
        override suspend fun answer(questionId: String, text: String) { events += "answer:$questionId:$text" }
    }

    @Test fun `plain words never execute a command and addressed send is ordered`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.hear("send it"); assertEquals("send it", h.text)
        r.hear("Nekko send it")
        assertTrue(h.events.contains("send:send it")); assertEquals("", h.text)
        r.hear("Nekko delete everything")
        assertEquals("Nekko delete everything", h.text)
    }
    @Test fun `multiple sentences type then send then type in order`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.hear("Build it. Nekko. Send it. Another thought.")
        assertTrue(h.events.contains("send:Build it."))
        assertEquals("Another thought.", h.text)
    }
    @Test fun `erase does not delete user edits and clear explicitly empties draft`() = runTest {
        val h = Host(); h.text = "typed"
        val r = VoiceRunner(backgroundScope, h)
        r.hear("spoken"); r.hear("Nekko erase that")
        assertEquals("typed", h.text)
        r.hear("new words"); h.text += " manually edited"
        r.hear("Nekko erase that"); assertEquals("typed new words manually edited", h.text)
        r.hear("Nekko clear"); assertEquals("", h.text)
    }
    @Test fun `wake carry expires and abort drops it`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h, { testScheduler.currentTime })
        r.hear("Neko."); r.hear("send it")
        assertTrue(h.events.contains("toast:Nothing to send"))
        r.hear("Nekko"); advanceTimeBy(5001); r.hear("send it")
        assertEquals("send it", h.text)
        r.hear("Nekko"); r.abort(); r.hear("clear it")
        assertEquals("send it clear it", h.text)
    }
    @Test fun `completion requires confirmation consumed exactly once and held prompts survive next hold`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.started(); r.hear("Nekko complete this session")
        val pending = r.pending.value!!
        assertFalse(h.events.contains("complete"))
        r.stopped(afterHold = true); r.started()
        r.answer(VoiceIntent.Yes, pending.id); r.answer(VoiceIntent.Yes, pending.id)
        assertEquals(1, h.events.count { it == "complete" }); assertNull(r.pending.value)
    }
    @Test fun `expired cancelled replaced and stale button confirmations cannot run`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h, { testScheduler.currentTime })
        r.hear("Nekko complete this session"); val old = r.pending.value!!.id
        r.hear("Nekko no"); r.answer(VoiceIntent.Yes, old)
        r.hear("Nekko complete this session"); val second = r.pending.value!!.id
        r.answer(VoiceIntent.Yes, old); assertEquals(second, r.pending.value!!.id)
        advanceTimeBy(60_001); runCurrent()
        assertNull(r.pending.value)
        r.hear("Nekko yes"); assertFalse(h.events.contains("complete"))
    }
    @Test fun `lock invalidates pending commands and normal continuous stop clears pending`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.hear("Nekko complete this session"); r.abort(); r.hear("Nekko yes")
        assertFalse(h.events.contains("complete"))
        r.hear("Nekko complete this session"); r.stopped()
        assertNull(r.pending.value)
    }
    @Test fun `navigation parks remaining words and never sends into another chat`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.hear("Nekko start new chat. hello there. Nekko send it.")
        assertTrue(h.events.contains("new")); assertTrue(h.events.contains("park:hello there."))
        assertFalse(h.events.any { it.startsWith("send:") })
        r.park(); r.hear("Nekko send it")
        assertTrue(h.events.contains("park:Nekko send it"))
    }
    @Test fun `settings works but desktop navigation is explicitly unsupported`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        r.hear("Nekko open settings"); assertTrue(h.events.contains("settings"))
        r.hear("Nekko go to desktop two")
        assertEquals(VoiceRunner.COMPUTER_ONLY, r.notice.value)
        assertEquals("", h.text)
    }
    @Test fun `chat lookup picks a single match offers three and preserves unmatched words`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        h.availableChats = listOf(VoiceRunner.Chat("1", "Billing"))
        r.hear("Nekko open billing"); assertTrue(h.events.contains("open:1"))
        h.availableChats += VoiceRunner.Chat("2", "Billing fix")
        r.hear("Nekko open billing"); assertFalse(r.pending.value!!.confirm)
        r.hear("Nekko the second one"); assertTrue(h.events.contains("open:2"))
        r.hear("Nekko open unknown topic"); assertEquals("Nekko open unknown topic", h.text)
    }
    @Test fun `ship confirms real PR merge and separately offers waiting question`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        h.facts = VoiceRunner.ShipFacts(listOf(VoiceRunner.PullRequest("42", "#42")))
        r.hear("Nekko ship it"); assertTrue(r.pending.value!!.confirm)
        r.hear("Nekko yes"); assertTrue(h.events.contains("merge:42"))
        h.facts = h.facts.copy(questionId = "q")
        r.hear("Nekko ship it"); assertFalse(r.pending.value!!.confirm)
        r.hear("Nekko yes"); assertNotNull(r.pending.value)
        r.hear("Nekko second"); assertTrue(h.events.contains("answer:q:Go ahead and build it."))
        assertNull(r.pending.value)
    }
    @Test fun `ship while running does not send and ship without PR sends go ahead`() = runTest {
        val h = Host(); val r = VoiceRunner(backgroundScope, h)
        h.facts = VoiceRunner.ShipFacts(running = true)
        r.hear("Nekko ship it"); assertFalse(h.events.any { it.startsWith("send:") })
        h.facts = VoiceRunner.ShipFacts(); h.text = "My plan"
        r.hear("Nekko ship it"); assertTrue(h.events.contains("send:My plan. Go ahead and build it."))
    }
    @Test fun `abort during noncooperative send invalidates queued words and stale toast`() = runTest {
        val waiting = CompletableDeferred<Unit>()
        val h = object : Host() {
            override suspend fun send(): Boolean { events += "send"; waiting.await(); return true }
        }
        h.text = "first"
        val r = VoiceRunner(backgroundScope, h)
        val a = launch { r.hear("Nekko send it") }
        val b = launch { r.hear("stale words") }
        runCurrent(); r.abort(); waiting.complete(Unit); runCurrent()
        a.join(); b.join()
        assertEquals("first", h.text)
        assertFalse(h.events.contains("toast:Sent"))
        r.hear("fresh words"); assertEquals("first fresh words", h.text)
    }
    @Test fun `transport failures consume confirmation and remain visible`() = runTest {
        val h = object : Host() { override suspend fun complete() { error("No permission") } }
        val r = VoiceRunner(backgroundScope, h)
        r.hear("Nekko complete this session"); r.hear("Nekko yes")
        assertNull(r.pending.value); assertEquals("No permission", r.notice.value)
    }
}
