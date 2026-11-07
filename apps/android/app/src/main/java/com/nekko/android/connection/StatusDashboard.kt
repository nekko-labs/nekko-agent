package com.nekko.android.connection

import com.nekko.protocol.LiveCardState

/** Content-free totals, shared by the notification and app-wide voice status. */
object StatusDashboard {
    fun summary(card: LiveCardState): String {
        val counts = card.counts ?: card.chats.groupingBy { it.state.wire }.eachCount()
        fun n(state: String) = (counts[state] ?: 0).coerceAtLeast(0)
        return "${n("working")} Building · ${n("needsYou")} Need input · ${n("done")} Done"
    }

    fun detail(card: LiveCardState): String {
        val counts = card.counts ?: card.chats.groupingBy { it.state.wire }.eachCount()
        return buildList {
            for ((state, label) in listOf("watching" to "Watching", "failed" to "Failed")) {
                val n = counts[state] ?: 0
                if (n > 0) add("$n $label")
            }
            if (card.counts == null && card.more > 0) add("Partial counts; ${card.more} more not included")
        }.joinToString(" · ")
    }
}
