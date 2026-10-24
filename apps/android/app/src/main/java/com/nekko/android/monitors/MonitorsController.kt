package com.nekko.android.monitors

import com.nekko.android.data.Caller
import com.nekko.protocol.AgentEvent
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Channels
import com.nekko.protocol.MonitorSummary
import com.nekko.protocol.PendingInput
import com.nekko.protocol.PhoneRefusal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/** What the Monitors screen draws. */
data class MonitorsState(
    /** The last answer; kept on screen through a failed refresh. */
    val summary: MonitorSummary? = null,
    /** The first read hasn't answered yet. */
    val loading: Boolean = true,
    /** Why the last read failed (the computer is offline, say). */
    val error: String? = null,
    /** The computer refused `monitor:summary` because Read is off for this phone. */
    val readOff: Boolean = false,
    /** When [summary] was read, on the phone's clock: running times count on from here. */
    val readAt: Long? = null,
    /** Approvals and questions answered from here, hidden until the next read drops them. */
    val handled: Set<String> = emptySet(),
) {
    /** What needs the owner, without what was just answered. */
    val needsYou: List<MonitorSummary.NeedsYou> get() = summary?.needsYou.orEmpty().filter { it.key !in handled }
}

/**
 * The Monitors pane and the closed phone's Monitors screen: one `monitor:summary`
 * read every [MonitorSummary.POLL_MS] while on screen (never in the background),
 * again when an agent event says something changed, and Allow / Deny / answer
 * inline through the same `tool:approve` and `chat:answer` calls the chat uses.
 * The logic without Android, like [com.nekko.android.chat.ChatController].
 */
class MonitorsController(
    private val caller: Caller,
    private val computerName: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(MonitorsState())
    val state: StateFlow<MonitorsState> = _state.asStateFlow()

    suspend fun refresh() {
        try {
            val summary = MonitorSummary.from(caller.call(Channels.MONITOR_SUMMARY))
            val keys = summary.needsYou.mapTo(HashSet()) { it.key }
            _state.update {
                MonitorsState(summary = summary, loading = false, readAt = now(), handled = it.handled.filterTo(HashSet()) { k -> k in keys })
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val refusal = PhoneRefusal.parse(e.message)
            _state.update {
                if (refusal?.code == READ_OFF) {
                    MonitorsState(loading = false, readOff = true)
                } else {
                    it.copy(loading = false, readOff = false, error = refusal?.message(computerName()) ?: e.message ?: "Couldn’t read ${computerName()}’s monitors.")
                }
            }
        }
    }

    /** Reads now and every [MonitorSummary.POLL_MS] until cancelled (the screen left, the app went to the background). */
    suspend fun poll() {
        while (true) {
            refresh()
            delay(MonitorSummary.POLL_MS)
        }
    }

    /** Whether [e] changes what Monitors shows (a chat started waiting, was answered, or finished). */
    fun changes(e: AgentEvent): Boolean = when (e) {
        is AgentEvent.ApprovalRequired, is AgentEvent.Question, is AgentEvent.QuestionResolved,
        is AgentEvent.Done, is AgentEvent.Error, is AgentEvent.SessionMeta -> true
        else -> false
    }

    /** **Allow** / **Deny** from Monitors: the same `tool:approve` as the chat's card. Throws so the row can say why. */
    suspend fun decide(row: MonitorSummary.NeedsYou, ok: Boolean) {
        require(row.kind == MonitorSummary.Kind.APPROVAL)
        caller.call(Channels.TOOL_APPROVE, JsonPrimitive(row.sessionId), JsonPrimitive(row.callId), JsonPrimitive(ok))
        _state.update { it.copy(handled = it.handled + row.key) }
    }

    /**
     * The question behind a *Needs you* row, read from `chat:pending` when the owner
     * taps Answer (`monitor:summary` carries only its first line); null once it has
     * been answered elsewhere.
     */
    suspend fun question(row: MonitorSummary.NeedsYou): AskRequest? =
        PendingInput.map(caller.call(Channels.CHAT_PENDING))[row.sessionId]?.question?.takeIf { it.callId == row.callId }

    /** The answer, through the same `chat:answer` as the chat's question card. */
    suspend fun answer(row: MonitorSummary.NeedsYou, answers: List<AskAnswer>) {
        caller.call(Channels.CHAT_ANSWER, JsonPrimitive(row.sessionId), JsonPrimitive(row.callId), JsonArray(answers.map { it.toJson() }))
        _state.update { it.copy(handled = it.handled + row.key) }
    }

    private companion object {
        const val READ_OFF = "read-off"
    }
}
