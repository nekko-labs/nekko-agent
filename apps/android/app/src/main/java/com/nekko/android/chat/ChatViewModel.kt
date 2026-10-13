package com.nekko.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersState
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.RelayState
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Android wrapper around [ChatController]: wires it to the repository's state and events. */
class ChatViewModel(sessionId: String, private val repo: ComputersRepository) : ViewModel() {
    private val controller = ChatController(sessionId, repo.caller, viewModelScope, { env(repo.state.value) })

    val ui: StateFlow<ChatUi> = combine(controller.state, repo.state.map(this::env).distinctUntilChanged()) { s, e ->
        ChatController.project(s, e)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ChatController.project(controller.state.value, env(repo.state.value)))

    init {
        // Load when the computer is reachable, and again after every reconnect.
        viewModelScope.launch {
            repo.state.map { it.conn }.distinctUntilChanged().collect { if (it == RelayState.ONLINE) controller.reload() }
        }
        viewModelScope.launch {
            repo.events.collect { e -> if (controller.onEvent(e)) launch { controller.reload() } }
        }
    }

    suspend fun send(text: String) = controller.send(text)
    fun stop() = controller.stop()
    suspend fun approve(ok: Boolean) = controller.approve(ok)
    suspend fun answer(answers: List<AskAnswer>) = controller.answer(answers)

    private fun env(s: ComputersState) = ChatEnv(
        conn = s.conn,
        denied = s.denied,
        defaults = s.defaults,
        computerName = s.active?.name ?: "your computer",
    )
}
