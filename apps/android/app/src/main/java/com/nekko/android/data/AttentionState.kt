package com.nekko.android.data

import com.nekko.protocol.AgentEvent
import com.nekko.protocol.E2E
import com.nekko.protocol.PendingInput

/** Actual waiting inputs, not unread chats. Opening a chat never changes this set. */
data class AttentionState(
    val pending: Map<String, PendingInput> = emptyMap(),
    val version: Long = 0,
    val known: Boolean = false,
    private val changed: Map<String, Long> = emptyMap(),
    private val dismissed: Map<String, Long> = emptyMap(),
) {
    /** Explicit resolutions can clear retained OS notifications before the first successful snapshot. */
    val resolved: Set<String> get() = changed.keys - pending.keys
    fun next(e: AgentEvent): AttentionState {
        val old = pending[e.sessionId] ?: PendingInput(e.sessionId, null, null)
        val input = when (e) {
            is AgentEvent.ApprovalRequired -> old.copy(approval = e.approval)
            is AgentEvent.Question -> old.copy(question = e.request)
            is AgentEvent.ToolResultReady -> if (old.approval == null || old.approval?.call?.id == e.result.toolCallId) old.copy(approval = null) else return this
            is AgentEvent.QuestionResolved -> if (old.question == null || old.question?.callId == e.callId) old.copy(question = null) else return this
            is AgentEvent.Done, is AgentEvent.Error -> null
            else -> return this
        }
        return replace(e.sessionId, input)
    }

    fun dismiss(tag: String): AttentionState {
        val id = pending.keys.firstOrNull { E2E.activityTag(it) == tag }
        val next = if (id == null) copy(version = version + 1) else replace(id, null)
        return next.copy(dismissed = next.dismissed + (tag to next.version))
    }

    fun remove(id: String): AttentionState = replace(id, null)

    /** A successful answer from this phone, even if the host's resolution event is delayed. */
    fun answered(id: String, callId: String, approval: Boolean): AttentionState {
        val input = pending[id] ?: return replace(id, null)
        val next = if (approval && input.approval?.call?.id == callId) input.copy(approval = null)
        else if (!approval && input.question?.callId == callId) input.copy(question = null)
        else return this
        return replace(id, next)
    }

    /** Newer events win over a pending read already in flight, including resolutions. */
    fun reconcile(snapshot: Map<String, PendingInput>?, requestedAt: Long): AttentionState {
        if (snapshot == null) return this // Failed read: unknown, not an empty waiting set.
        val merged = snapshot.filter { (id, input) ->
            (input.approval != null || input.question != null) && (dismissed[E2E.activityTag(id)] ?: 0) <= requestedAt
        }.toMutableMap()
        changed.filterValues { it > requestedAt }.keys.forEach { id ->
            val latest = pending[id]
            if (latest == null) merged.remove(id) else merged[id] = latest
        }
        return copy(pending = merged, known = true)
    }

    private fun replace(id: String, input: PendingInput?): AttentionState = copy(
        pending = if (input?.approval == null && input?.question == null) pending - id else pending + (id to input),
        version = version + 1,
        changed = changed + (id to version + 1),
    )
}
