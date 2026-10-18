package com.nekko.android.share

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds text shared into the app until it lands in a chat's composer. App-scoped
 * and in memory only: a share is never written to disk, and it is gone if the
 * process dies before the user starts the chat.
 *
 * 1. The share sheet hands over text: [offer]. New chat shows it, editable.
 * 2. The user starts the chat: [handOff] moves it to that chat's composer.
 * 3. The chat screen takes it once: [takeDraft]. Nothing is sent by Nekko.
 *
 * Leaving New chat with Back, or removing the text there, drops it ([clear]).
 */
class ShareInbox {
    private val _shared = MutableStateFlow<String?>(null)
    /** The text waiting for New chat, if any. */
    val shared: StateFlow<String?> = _shared.asStateFlow()

    private val drafts = HashMap<String, String>()

    /** A new share replaces one that was never used. */
    fun offer(text: String) {
        _shared.value = text
    }

    /** The user edited the text on New chat. Blank removes it. */
    fun edit(text: String) {
        _shared.value = text.ifBlank { null }
    }

    fun clear() {
        _shared.value = null
    }

    /** The chat [sessionId] was created: its composer opens with the shared text. */
    fun handOff(sessionId: String) {
        val text = _shared.value ?: return
        _shared.value = null
        synchronized(drafts) { drafts[sessionId] = text }
    }

    /** The composer text for [sessionId], once; null when nothing was shared into it. */
    fun takeDraft(sessionId: String): String? = synchronized(drafts) { drafts.remove(sessionId) }
}
