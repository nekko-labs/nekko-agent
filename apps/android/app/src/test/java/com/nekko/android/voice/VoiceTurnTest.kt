package com.nekko.android.voice

import com.nekko.protocol.ChatMessage
import com.nekko.protocol.Session
import org.junit.Assert.*
import org.junit.Test

class VoiceTurnTest {
    private fun message(id: String, role: String, text: String) = ChatMessage(id, role, text)
    private val before = Session("s", "Chat", "p", "m", null,
        listOf(message("old-u", "user", "hello"), message("old-a", "assistant", "Old reply")), queue = emptyList(), updatedAt = 1)
    private fun after() = before.copy(messages = before.messages + listOf(message("u", "user", "hello"), message("a", "assistant", "Fresh reply")), clientMessageIds = listOf("voice-1"))
    private fun refused(block: () -> Unit) { try { block(); fail("Expected a fail-closed refusal") } catch (_: IllegalStateException) {} }

    @Test fun `reply is fresh even when prompt repeats`() { assertEquals("Fresh reply", VoiceTurn.reply(before, after(), "hello", "voice-1")) }
    @Test fun `idle old reply and missing delivery correlation are never spoken`() {
        refused { VoiceTurn.reply(before, before, "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(clientMessageIds = emptyList()), "hello", "voice-1") }
        refused { VoiceTurn.reply(before.copy(clientMessageIds = listOf("voice-1")), after(), "hello", "voice-1") }
    }
    @Test fun `changed truncated and competing transcripts fail closed`() {
        refused { VoiceTurn.reply(before, after().copy(messages = after().messages.drop(2)), "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(messages = after().messages + message("other", "user", "next")), "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(id = "other"), "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after(), "different words", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(running = true), "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(queue = listOf("next")), "hello", "voice-1") }
    }
    @Test fun `interrupted tool-only and reasoning-only results are not spoken`() {
        val prompt = after().messages.dropLast(1)
        refused { VoiceTurn.reply(before, after().copy(messages = prompt + message("a", "assistant", "partial").copy(interrupted = true)), "hello", "voice-1") }
        refused { VoiceTurn.reply(before, after().copy(messages = prompt + message("a", "assistant", "").copy(reasoning = "private reasoning")), "hello", "voice-1") }
    }
    @Test fun `conversation preflight protects drafts attachments armed prompts running queues and offline state`() {
        VoiceTurn.preflight(before, true, true, false, false)
        fun reject(session: Session? = before, online: Boolean = true, authorized: Boolean = true, running: Boolean = false, outbox: Boolean = false, draft: VoiceTurn.Draft = VoiceTurn.Draft()) = refused {
            VoiceTurn.preflight(session, online, authorized, running, outbox, draft)
        }
        reject(session = null); reject(session = before.copy(chatType = "image")); reject(online = false); reject(authorized = false)
        reject(running = true); reject(session = before.copy(running = true)); reject(outbox = true)
        reject(session = before.copy(queue = listOf("waiting")))
        reject(draft = VoiceTurn.Draft(text = "keep me")); reject(draft = VoiceTurn.Draft(armed = true))
        reject(draft = VoiceTurn.Draft(photos = true)); reject(draft = VoiceTurn.Draft(busy = true))
        VoiceTurn.preflight(before, true, true, false, false, VoiceTurn.Draft(text = "send me"), conversation = false)
    }
    @Test fun `one audio owner across panes and stale owner cannot cancel replacement`() {
        val paneA = Any(); val paneB = Any(); var stoppedA = 0; var stoppedB = 0
        try {
            VoiceAudioOwner.claim(paneA) { stoppedA++ }
            VoiceAudioOwner.claim(paneA) { stoppedA++ }
            VoiceAudioOwner.claim(paneB) { stoppedB++ }
            assertEquals(1, stoppedA); assertTrue(VoiceAudioOwner.owns(paneB))
            VoiceAudioOwner.release(paneA)
            assertEquals(0, stoppedB)
            VoiceAudioOwner.release(paneB); assertEquals(1, stoppedB)
        } finally { VoiceAudioOwner.release(paneA); VoiceAudioOwner.release(paneB) }
    }
}
