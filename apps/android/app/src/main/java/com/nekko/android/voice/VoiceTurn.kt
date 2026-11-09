package com.nekko.android.voice

import com.nekko.protocol.Session

/** Fail closed: speech is never an offline/outbox or queued prompt. Also used at the UI's Start boundary. */
object VoiceTurn {
    data class Draft(val text: String = "", val armed: Boolean = false, val photos: Boolean = false, val busy: Boolean = false)

    fun preflight(session: Session?, online: Boolean, authorized: Boolean, running: Boolean, outbox: Boolean, draft: Draft = Draft(), conversation: Boolean = true) {
        check(authorized && online) { "Voice stopped. Unlock and reconnect, then start again." }
        check(session != null) { "Wait for this chat to load." }
        check(session.chatType != "image") { "Voice conversation is available in text chats only." }
        check(!running && !session.running && session.queue.isEmpty() && session.queued.isEmpty() && !outbox) { "Wait for this chat and its waiting prompts to finish." }
        check(!draft.armed && !draft.photos && !draft.busy && (!conversation || draft.text.isBlank())) { "Keep your draft: remove attachments and armed prompts, and send or clear the message box before starting voice conversation." }
    }

    /** The awaited request, not an idle frame or a Done event, identifies completion. */
    fun reply(before: Session, after: Session?, text: String, clientId: String): String {
        check(after != null && after.id == before.id) { "This chat is no longer available." }
        check(!after.running && after.queue.isEmpty() && after.queued.isEmpty()) { "Another turn is running or waiting. Voice stopped." }
        check(clientId in after.clientMessageIds && clientId !in before.clientMessageIds) { "The computer did not confirm this voice prompt. Check the chat before trying again." }
        val anchor = before.messages.lastOrNull()?.id
        val start = if (anchor == null) 0 else after.messages.indexOfLast { it.id == anchor }.also {
            check(it >= 0) { "The transcript changed while voice was waiting." }
        } + 1
        val fresh = after.messages.drop(start)
        val oldIds = before.messages.map { it.id }.toSet()
        check(fresh.none { it.id in oldIds }) { "The transcript changed while voice was waiting." }
        val prompts = fresh.filter { it.role == "user" }
        check(prompts.size == 1 && prompts.single().content == text && prompts.single().skill == null && prompts.single().images.isEmpty()) { "Could not identify this voice turn. Check the chat before trying again." }
        val promptAt = fresh.indexOf(prompts.single())
        check(fresh.take(promptAt).isEmpty()) { "Another reply arrived before this voice prompt." }
        val answers = fresh.drop(promptAt + 1).filter { it.role == "assistant" }
        check(answers.none { it.interrupted }) { "The reply was interrupted. Voice stopped." }
        val final = answers.lastOrNull()
        check(final != null && final.toolCalls.isEmpty() && final.content.isNotBlank()) { "This turn finished without a new spoken reply." }
        return final.content.trim()
    }
}

/** Main-thread audio lease shared by all chat panes and legacy dictation. Identity release cannot stop a newer owner. */
object VoiceAudioOwner {
    private var owner: Any? = null
    private var stop: (() -> Unit)? = null
    fun claim(token: Any, onStop: () -> Unit) {
        if (owner === token) { stop = onStop; return }
        val previous = stop
        owner = null; stop = null
        previous?.invoke()
        owner = token; stop = onStop
    }
    fun owns(token: Any): Boolean = owner === token
    fun release(token: Any) {
        if (owner !== token) return
        val previous = stop
        owner = null; stop = null
        previous?.invoke()
    }
}
