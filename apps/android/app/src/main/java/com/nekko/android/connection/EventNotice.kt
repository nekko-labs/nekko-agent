package com.nekko.android.connection

import com.nekko.android.chat.PhoneEvent

/**
 * A local notification about one computer chat. One awaiting-input notification
 * and one non-badging reply per chat: a stable [tag] deduplicates events while
 * separate notification IDs prevent a racing resolution from canceling a reply.
 * Native FCM registration is not implemented (AN-6). Any future push must match
 * both the tag and category ID to replace a local alert rather than show twice.
 */
data class EventNotice(
    val sessionId: String,
    val event: PhoneEvent,
    val title: String,
    val text: String,
    /** The waiting tool call, for an approval: the notification's Deny answers it. */
    val callId: String? = null,
) {
    /** Only an approval offers Deny; Allow needs the command in view, so it stays in the chat. */
    val canDeny: Boolean get() = event == PhoneEvent.APPROVAL && !callId.isNullOrEmpty()

    /** Approval and question wait on the user: their own, louder channel. */
    val needsYou: Boolean get() = event == PhoneEvent.APPROVAL || event == PhoneEvent.NEEDS_INPUT

    companion object {
        fun tag(sessionId: String) = "chat:$sessionId"

        /**
         * The words on the notification. Never the reply, the command or the
         * question: only what happened and, unless [hideContent], the chat's
         * title and computer. With the app lock on, [hideContent] keeps even the
         * title off the lock screen and the shade.
         */
        fun of(
            sessionId: String,
            event: PhoneEvent,
            chatTitle: String?,
            computer: String,
            hideContent: Boolean,
            callId: String? = null,
        ): EventNotice {
            val title = when (event) {
                PhoneEvent.FINISHED -> "Reply ready"
                PhoneEvent.FAILED -> "Reply failed"
                PhoneEvent.NEEDS_INPUT -> "Question waiting"
                PhoneEvent.APPROVAL -> "Approval needed"
            }
            val chat = chatTitle?.trim()?.takeIf { it.isNotEmpty() }?.take(80)
            val text = when {
                hideContent -> "Open Nekko to see it."
                chat != null -> "$chat · $computer"
                else -> "A chat on $computer"
            }
            return EventNotice(sessionId, event, title, text, callId.takeIf { event == PhoneEvent.APPROVAL })
        }
    }
}
