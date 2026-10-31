package com.nekko.android.computer

import com.nekko.android.data.Caller
import com.nekko.protocol.Channels
import com.nekko.protocol.MachineSummary
import com.nekko.protocol.RoundTrip
import com.nekko.protocol.RoundTrips
import com.nekko.protocol.UsageSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * What a computer's page shows (the iPhone's `MachineModel`): the computer's
 * own summary (`machine:summary`), its usage today, and the round trip the
 * phone measures itself, so the page works on any computer version. Models and
 * providers come from the repository's state. Refreshes every 30 s while open.
 */
class MachineController(
    private val caller: Caller,
    private val scope: CoroutineScope,
    /** Whether this page's computer is the one in use and online: the only time it is asked. */
    private val reachable: () -> Boolean,
    /** Re-read the enabled providers' models into the repository's state. */
    private val loadModels: suspend () -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
    private val clock: () -> Long = System::nanoTime,
) {
    data class State(
        val summary: MachineSummary? = null,
        /** Why the summary is missing: an old computer or no answer. */
        val summaryError: String? = null,
        val usage: UsageSummary? = null,
        val samples: List<RoundTrip> = emptyList(),
        val loading: Boolean = false,
        val loadedOnce: Boolean = false,
    ) {
        val latest: RoundTrip? get() = samples.lastOrNull()

        /** The models the computer has loaded, by id, from its summary. */
        val loadedIds: Set<String> get() = summary?.resident?.map { it.id }?.toSet().orEmpty()

        fun today(now: Long): UsageSummary.Day? = usage?.days?.firstOrNull { it.date == RoundTrips.dayKey(now) }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    private var loop: Job? = null

    fun start() {
        if (loop != null) return
        loop = scope.launch {
            while (true) {
                refresh()
                delay(30_000)
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
    }

    /** One pass: the round trip first (the cheapest call), then the rest. Failures keep the last state. */
    suspend fun refresh() {
        if (!reachable()) return
        _state.update { it.copy(loading = true) }
        try {
            measure()
            val summary = attempt { MachineSummary.from(caller.call(Channels.MACHINE_SUMMARY)) }
            _state.update { s ->
                when {
                    summary != null -> s.copy(summary = summary.getOrNull(), summaryError = if (summary.getOrNull() == null) "This computer didn’t answer with its details." else null)
                    s.summary == null -> s.copy(summaryError = "This computer is too old to send its details. Update Nekko Agent there.")
                    else -> s
                }
            }
            runCatching { loadModels() }
            attempt { UsageSummary.from(caller.call(Channels.USAGE_SUMMARY)) }?.getOrNull()?.let { u -> _state.update { it.copy(usage = u) } }
        } finally {
            _state.update { it.copy(loading = false, loadedOnce = true) }
        }
    }

    /** Time `app:info`, the lightest open channel, and keep the sample. */
    suspend fun measure() {
        val t0 = clock()
        attempt { caller.call(Channels.APP_INFO) } ?: return
        val ms = ((clock() - t0) / 1_000_000).toInt()
        _state.update { it.copy(samples = RoundTrips.append(it.samples, RoundTrip(now(), ms))) }
    }

    /** The call's result wrapped (a null answer stays a success), or null when it failed. */
    private suspend fun <T> attempt(call: suspend () -> T): Result<T>? = try {
        Result.success(call())
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}
