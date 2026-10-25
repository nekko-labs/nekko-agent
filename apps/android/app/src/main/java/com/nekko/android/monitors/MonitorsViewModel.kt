package com.nekko.android.monitors

import androidx.lifecycle.ViewModel
import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.MonitorSummary
import com.nekko.protocol.RelayState
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Android wrapper around [MonitorsController]: the active computer's connection and events. */
class MonitorsViewModel(private val repo: ComputersRepository) : ViewModel() {
    private val controller = MonitorsController(repo.caller, computerName = { repo.state.value.active?.name ?: "your computer" })

    val state: StateFlow<MonitorsState> = controller.state

    /**
     * Run while the screen is visible (the caller ties this to the lifecycle's STARTED
     * state): reads every 10 s while the computer is online, and again on each agent
     * event that changes what needs the owner. Returns only when cancelled.
     */
    suspend fun whileVisible() = coroutineScope {
        launch {
            repo.events.collect { e -> if (controller.changes(e)) controller.refresh() }
        }
        // Going offline cancels the poll; coming back starts it again with a read at once.
        repo.state.map { it.conn == RelayState.ONLINE }.distinctUntilChanged().collectLatest { online ->
            if (online) controller.poll()
        }
    }

    suspend fun refresh() = controller.refresh()

    suspend fun decide(row: MonitorSummary.NeedsYou, ok: Boolean) = controller.decide(row, ok)

    suspend fun question(row: MonitorSummary.NeedsYou): AskRequest? = controller.question(row)

    suspend fun answer(row: MonitorSummary.NeedsYou, answers: List<AskAnswer>) = controller.answer(row, answers)
}
