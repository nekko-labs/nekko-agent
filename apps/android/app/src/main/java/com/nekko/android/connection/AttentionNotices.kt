package com.nekko.android.connection

import com.nekko.android.chat.PhoneEvent
import com.nekko.android.data.ComputersState

/** One badge unit per listed waiting chat, never per event, input or unread message. */
object AttentionNotices {
    data class Update(val computer: String?, val waiting: List<EventNotice>, val silent: Boolean, val authoritative: Boolean, val resolved: Set<String>)

    fun update(state: ComputersState, enabled: Boolean, hideContent: Boolean, visible: Boolean): Update? {
        if (!state.ready) return null // Launching the app is not an empty authoritative waiting set.
        return Update(state.activeId, of(state, enabled, hideContent), visible,
            !enabled || state.activeId == null || state.attention.known, state.attention.resolved)
    }

    fun of(state: ComputersState, enabled: Boolean, hideContent: Boolean): List<EventNotice> {
        if (!enabled) return emptyList()
        val titles = state.summaries.associate { it.id to it.title }
        return state.attention.pending.mapNotNull { (id, input) ->
            if (id !in titles) return@mapNotNull null // Same top-level-chat scope as local alerts.
            val event = when {
                input.approval != null -> PhoneEvent.APPROVAL
                input.question != null -> PhoneEvent.NEEDS_INPUT
                else -> return@mapNotNull null
            }
            EventNotice.of(id, event, titles[id], state.active?.name ?: "your computer", hideContent, input.approval?.call?.id, input.approval?.call?.name)
        }
    }
}
