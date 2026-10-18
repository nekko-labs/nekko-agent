package com.nekko.android.connection

import com.nekko.android.chat.PhoneEvent

/**
 * A local notification about one computer chat. One per chat at a time: the
 * notification is tagged with the session id, so a newer event replaces the
 * older one. Push notifications (FCM, AN-6) must use the same [tag] so a push
 * that arrives while the relay is also connected replaces this one instead of
 * showing twice.
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
