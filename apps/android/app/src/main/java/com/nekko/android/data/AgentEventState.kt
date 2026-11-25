package com.nekko.android.data

import com.nekko.protocol.Activity
import com.nekko.protocol.ActivityTracker
import com.nekko.protocol.AgentEvent

/**
 * [s] after one agent event: the chat's activity and the attention it needs. The same state comes
 * back when the event changes neither (most events of a streaming reply), so a streamed token
 * copies no map and publishes nothing (the iPhone's `if next != activity`).
 */
internal fun withAgentEvent(s: ComputersState, e: AgentEvent): ComputersState {
    val attention = s.attention.next(e)
    var activity = ActivityTracker.next(s.activity, e)
    for (id in attention.pending.keys) if (activity[id] != Activity.NEEDS_YOU) activity = activity + (id to Activity.NEEDS_YOU)
    return if (activity == s.activity && attention == s.attention) s else s.copy(activity = activity, attention = attention)
}
