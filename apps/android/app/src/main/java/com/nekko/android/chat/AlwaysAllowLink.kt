package com.nekko.android.chat

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * **Always allow this tool** from the approval notification (the iPhone's
 * `AppModel.alwaysAllowIn`). The action only opens the chat
 * (`nekko-agent://chat/<id>?alwaysAllow=<call id>`): saving the tool is a guarded
 * `session:setOptions` with a Change proof behind the phone's own authentication,
 * which needs the app in front. That chat's approval card then runs its own
 * Always allow, once, and only for that very call.
 *
 * Never behind the app lock: [take] waits for the unlock. A plain chat link
 * replaces the request ([opened] with no call) and leaving the app drops it
 * ([clear]), so an untaken one never runs later by itself.
 */
class AlwaysAllowLink {
    data class Request(val chatId: String, val callId: String)

    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request.asStateFlow()

    /** A chat link opened: its Always allow request, or none for a plain link. */
    fun opened(chatId: String, callId: String?) {
        _request.value = callId?.takeIf { it.isNotEmpty() }?.let { Request(chatId, it) }
    }

    fun clear() {
        _request.value = null
    }

    /**
     * True once, when [chatId]'s card shows the requested [callId] and the app is
     * not [locked]: the card then does what its own button does.
     */
    fun take(chatId: String, callId: String, locked: Boolean): Boolean {
        if (locked) return false
        val want = Request(chatId, callId)
        return _request.compareAndSet(want, null)
    }
}
