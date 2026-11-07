package com.nekko.android

import com.nekko.android.connection.StatusDashboard
import com.nekko.android.voice.NekkoVoice
import com.nekko.android.voice.VoiceGeneration
import com.nekko.protocol.LiveCard
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.LiveChat
import com.nekko.protocol.LiveChatState
import com.nekko.protocol.LiveLevel
import org.junit.Assert.*
import org.junit.Test

class NekkoVoiceTest {
    private val target = NekkoVoice.Target("chat-1", "Ship Android")
    private val card = LiveCardState(listOf(LiveChat("focused-secret", "secret", LiveChatState.WORKING,
        step = "credential", reply = "private transcript")), "focused-secret", counts = mapOf("working" to 3, "needsYou" to 2, "done" to 20, "watching" to 4, "failed" to 1))
    private val c = NekkoVoice.Context("pc-1", "Mac", true, true, card, listOf(target))
    private fun message(r: NekkoVoice.Result) = (r as NekkoVoice.Result.Message).text

    @Test fun `dashboard uses full set beyond eight with failures separate from done`() {
        val all = (1..20).map { LiveChat("done-$it", state = LiveChatState.DONE, finishedAt = 100.0) } +
            listOf(LiveChat("working", state = LiveChatState.WORKING), LiveChat("failed", state = LiveChatState.FAILED, finishedAt = 100.0))
        val built = LiveCard.build(all, null, null, LiveLevel.MINIMAL, 110.0)!!
        assertEquals(8, built.chats.size)
        assertEquals("1 Building · 0 Need input · 20 Done", StatusDashboard.summary(built))
        assertEquals("1 Failed", StatusDashboard.detail(built))
    }

    @Test fun `legacy zero and stale status are explicit without exposing content`() {
        val old = card.copy(counts = null, more = 18)
        assertTrue(StatusDashboard.detail(old).contains("Partial counts"))
        assertEquals("0 Building · 0 Need input · 0 Done", StatusDashboard.summary(LiveCardState(emptyList(), null)))
        val result = message(NekkoVoice().dispatch("status", c.copy(online = false, card = old)))
        assertTrue(result.startsWith("Offline or stale"))
        assertTrue(result.contains("Partial counts"))
        for (secret in listOf("focused-secret", "credential", "private transcript", "Ship Android")) assertFalse(result.contains(secret))
    }

    @Test fun `exact explicit target and exact message require confirmation and replay fails`() {
        val v = NekkoVoice()
        assertTrue(message(v.dispatch("send to Ship Android saying Hello", c, 0)).contains("Nothing sent yet"))
        assertEquals(NekkoVoice.Result.Send("pc-1", "chat-1", "Hello"), v.dispatch("confirm send to Ship Android saying Hello", c, 1))
        assertTrue(v.dispatch("confirm send to Ship Android saying Hello", c, 2) is NekkoVoice.Result.Message)
    }

    @Test fun `ambiguous missing substring and unloaded targets never select focus`() {
        for (context in listOf(c.copy(targets = listOf(target, target.copy(id = "other"))), c.copy(targets = emptyList()), c.copy(loaded = false))) {
            assertTrue(message(NekkoVoice().dispatch("send to Ship Android saying Hi", context)).startsWith("Not sent"))
        }
        assertTrue(message(NekkoVoice().dispatch("send to Ship saying Hi", c)).startsWith("Not sent"))
        assertTrue(message(NekkoVoice().dispatch("Hello focused chat", c)).startsWith("Not sent"))
    }

    @Test fun `stale confirmation changed scope target or text is rejected`() {
        for ((context, command, now) in listOf(
            Triple(c.copy(computerId = "pc-2"), "confirm send to Ship Android saying Hi", 1L),
            Triple(c.copy(targets = listOf(target.copy(id = "new-id"))), "confirm send to Ship Android saying Hi", 1L),
            Triple(c, "confirm send to Ship Android saying hi", 1L),
            Triple(c, "confirm send to Ship Android saying Hi", 60_000L))) {
            val v = NekkoVoice()
            v.dispatch("send to Ship Android saying Hi", c, 0)
            assertTrue(message(v.dispatch(command, context, now)).startsWith("Not sent"))
        }
    }

    @Test fun `sensitive unsupported actions route to app and invalidate confirmations`() {
        for (command in listOf("allow all", "deny approval", "stop Ship Android", "delete chat", "run shell", "status", "cancel")) {
            val v = NekkoVoice()
            v.dispatch("send to Ship Android: Hi", c, 0)
            assertTrue(v.dispatch(command, c, 1) is NekkoVoice.Result.Message)
            assertTrue(v.dispatch("confirm send to Ship Android: Hi", c, 2) is NekkoVoice.Result.Message)
        }
    }

    @Test fun `offline produces only an explicitly confirmed send request not delivery success`() {
        val v = NekkoVoice()
        val offline = c.copy(online = false)
        v.dispatch("send to Ship Android: Hi", offline, 0)
        assertEquals(NekkoVoice.Result.Send("pc-1", "chat-1", "Hi"), v.dispatch("confirm send to Ship Android: Hi", offline, 1))
        val denied = c.copy(loaded = false)
        assertTrue(v.dispatch("send to Ship Android: Hi", denied) is NekkoVoice.Result.Message)
    }

    @Test fun `authentication failure privacy cover denial and background forbid capture and routing`() {
        val allowed = com.nekko.android.voice.VoiceAccess
        assertTrue(allowed.allowed(true, false, false, true, false))
        assertFalse(allowed.allowed(false, false, false, true, false))
        assertFalse(allowed.allowed(true, true, false, true, false))
        assertFalse(allowed.allowed(true, false, true, true, false))
        assertFalse(allowed.allowed(true, false, false, false, false))
        assertFalse(allowed.allowed(true, false, false, true, true))
    }

    @Test fun `cancel permission failure and background invalidation reject late words`() {
        val generation = VoiceGeneration()
        val old = generation.begin()
        generation.cancel()
        assertFalse(generation.accepts(old))
        val current = generation.begin()
        assertFalse(generation.accepts(old))
        assertTrue(generation.accepts(current))
        val v = NekkoVoice()
        v.dispatch("send to Ship Android: Hi", c, 0)
        v.cancel()
        assertTrue(v.dispatch("confirm send to Ship Android: Hi", c, 1) is NekkoVoice.Result.Message)
    }
}
