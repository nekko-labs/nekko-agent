package com.nekko.android.widget

import com.nekko.android.data.ComputersState
import com.nekko.protocol.Activity
import com.nekko.protocol.RelayState

/**
 * What the Home Screen widget shows: counts, never chat titles or tool details,
 * so nothing private sits on a screen anyone can glance at. Same rules and
 * words as the iPhone's `StatusSnapshot` (apps/ios/App/Shared/StatusWidget.swift).
 */
data class StatusSnapshot(
    val computer: String?,
    val online: Boolean,
    val needsYou: Int,
    val running: Int,
    /** When the app last wrote it (epoch ms); the widget says how old the numbers are. */
    val at: Long,
) {
    val headline: String
        get() = when {
            computer == null -> "Not paired"
            needsYou > 0 -> if (needsYou == 1) "1 needs you" else "$needsYou need you"
            running > 0 -> if (running == 1) "1 working" else "$running working"
            online -> "All quiet"
            else -> "Offline"
        }

    /** Equal apart from when it was taken: nothing the widget shows changed. */
    fun sameAs(other: StatusSnapshot) = copy(at = 0) == other.copy(at = 0)

    companion object {
        val EMPTY = StatusSnapshot(null, online = false, needsYou = 0, running = 0, at = 0)

        fun of(state: ComputersState, now: Long) = StatusSnapshot(
            computer = state.active?.name,
            online = state.conn == RelayState.ONLINE,
            needsYou = state.activity.values.count { it == Activity.NEEDS_YOU },
            running = state.activity.values.count { it == Activity.RUNNING },
            at = now,
        )
    }
}
