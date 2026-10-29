package com.nekko.android.beyond

import com.nekko.android.data.Caller
import com.nekko.protocol.AutomationTask
import com.nekko.protocol.AutomationWorkflow
import com.nekko.protocol.Channels
import com.nekko.protocol.ProviderLimits
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayException
import com.nekko.protocol.UsageSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/** What the Automations screen draws. */
data class AutomationsState(
    val tasks: List<AutomationTask> = emptyList(),
    val workflows: List<AutomationWorkflow> = emptyList(),
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val error: String? = null,
    /** Automations Run now was sent for since the list was last read. */
    val started: Set<String> = emptySet(),
) {
    val isEmpty: Boolean get() = tasks.isEmpty() && workflows.isEmpty()
}

/**
 * The computer's automations on the phone (AN-29, the iPhone's
 * `AutomationsModel`): its tasks and workflows, how each last went, and Run
 * now on one the owner already set up. Making, changing, pausing or deleting
 * them stays on the computer (it refuses those).
 */
class AutomationsController(
    private val caller: Caller,
    private val online: () -> Boolean,
    private val scope: CoroutineScope,
    /** After Run now, when to read the list again so the run's result shows. */
    private val rereadMs: List<Long> = listOf(1_500, 4_000, 10_000, 20_000, 40_000),
) {
    private val _state = MutableStateFlow(AutomationsState())
    val state: StateFlow<AutomationsState> = _state.asStateFlow()

    suspend fun load(keepStarted: Boolean = false) {
        _state.update { it.copy(loading = true) }
        try {
            val (t, w) = coroutineScope {
                val t = async { caller.call(Channels.TASKS_LIST) }
                val w = async { caller.call(Channels.WORKFLOWS_LIST) }
                t.await() to w.await()
            }
            _state.update {
                it.copy(
                    tasks = AutomationTask.list(t), workflows = AutomationWorkflow.list(w), error = null,
                    started = if (keepStarted) it.started else emptySet(),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: "Couldn’t read the automations.") }
        }
        _state.update { it.copy(loading = false, loaded = true) }
    }

    /** Run a task now, as the desktop's Run now does. */
    suspend fun runTask(id: String) = runNow(id, Channels.TASK_RUN_NOW)

    /** Start a run of a workflow, as its Run button does. */
    suspend fun runWorkflow(id: String) = runNow(id, Channels.WORKFLOW_RUN)

    private suspend fun runNow(id: String, channel: String) {
        if (!online()) throw RelayException(RUN_OFFLINE)
        caller.call(channel, JsonPrimitive(id))
        _state.update { it.copy(started = it.started + id) }
        // The run takes a while to finish; read the list again a few times so its result shows.
        scope.launch {
            var waited = 0L
            for (at in rereadMs) {
                delay(at - waited)
                waited = at
                if (!online()) return@launch
                load(keepStarted = true)
            }
        }
    }

    companion object {
        const val RUN_OFFLINE = "Reconnect to run it. Run now is never sent later."
    }
}

/** What the Usage and limits screen draws. */
data class UsageState(
    val summary: UsageSummary? = null,
    /** The enabled providers that reported plan limits, in the computer's order. */
    val limited: List<Pair<PublicProvider, ProviderLimits>> = emptyList(),
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val error: String? = null,
)

/** The computer's provider usage and plan limits, read only (AN-29, the iPhone's `UsageModel`). */
class UsageController(private val caller: Caller, private val providers: () -> List<PublicProvider>) {
    private val _state = MutableStateFlow(UsageState())
    val state: StateFlow<UsageState> = _state.asStateFlow()

    suspend fun load() {
        _state.update { it.copy(loading = true) }
        try {
            val summary = UsageSummary.from(caller.call(Channels.USAGE_SUMMARY))
            // A provider without limits answers null; one that fails to read leaves no card.
            val enabled = providers().filter { it.enabled }
            val limits = coroutineScope {
                enabled.map { p ->
                    async {
                        val l = try {
                            ProviderLimits.from(caller.call(Channels.LIMITS_GET, JsonPrimitive(p.id)))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            null
                        }
                        l?.let { p to it }
                    }
                }.awaitAll().filterNotNull()
            }
            _state.update { it.copy(summary = summary, limited = limits, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: "Couldn’t read the usage.") }
        }
        _state.update { it.copy(loading = false, loaded = true) }
    }
}
