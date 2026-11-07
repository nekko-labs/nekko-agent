package com.nekko.android.data

import com.nekko.protocol.Activity
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.PendingInput

/** Actual waiting inputs, not unread chats. Opening a chat never changes this set. */
data class AttentionState(
    val pending: Map<String, PendingInput> = emptyMap(),
    val version: Long = 0,
    val known: Boolean = false,
    private val changed: Map<String, Long> = emptyMap(),
    private val snapshotVersion: Long? = null,
) {
    /** Only confirmed removals may clear retained OS notifications. */
    val resolved: Set<String> get() = if (known) changed.keys - pending.keys else emptySet()

    fun next(e: AgentEvent): AttentionState {
        val old = pending[e.sessionId] ?: PendingInput(e.sessionId, null, null)
        val input = when (e) {
            is AgentEvent.ApprovalRequired -> old.copy(approval = e.approval)
            is AgentEvent.Question -> old.copy(question = e.request)
            // chat:pending exposes only the newest input of each kind. Even a
            // matching resolution cannot prove that an older input is gone.
            is AgentEvent.ToolResultReady, is AgentEvent.QuestionResolved,
            is AgentEvent.Done, is AgentEvent.Error -> return invalidate()
            else -> return this
        }
        return replace(e.sessionId, input)
    }

    /** A resolution, legacy dismiss or lost connection needs a new complete read. */
    fun invalidate(): AttentionState = copy(known = false, version = version + 1, snapshotVersion = null)

    /** A new ticket also makes an older overlapping read obsolete. */
    fun beginSnapshot(): AttentionState = copy(version = version + 1, snapshotVersion = version + 1)

    fun remove(id: String): AttentionState = replace(id, null)

    /** New inputs win over a read in flight; resolutions invalidate that read entirely. */
    fun reconcile(snapshot: Map<String, PendingInput>?, requestedAt: Long): AttentionState {
        if (snapshotVersion != requestedAt) return this
        if (snapshot == null) return invalidate() // Failed read: unknown, never empty.
        val merged = snapshot.filterValues { it.approval != null || it.question != null }.toMutableMap()
        changed.filterValues { it > requestedAt }.keys.forEach { id ->
            val latest = pending[id]
            if (latest == null) merged.remove(id) else merged[id] = latest
        }
        return copy(pending = merged, known = true, changed = emptyMap(), snapshotVersion = null)
    }

    /** Replace only the needs-you rows, keeping running and failed ones. */
    fun projecting(activity: Map<String, Activity>): Map<String, Activity> =
        activity.filterValues { it != Activity.NEEDS_YOU } + pending.keys.associateWith { Activity.NEEDS_YOU }

    private fun replace(id: String, input: PendingInput?): AttentionState = copy(
        pending = if (input?.approval == null && input?.question == null) pending - id else pending + (id to input),
        version = version + 1,
        changed = changed + (id to version + 1),
    )
}
