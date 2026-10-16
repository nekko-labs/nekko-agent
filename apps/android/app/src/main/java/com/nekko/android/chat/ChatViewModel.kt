package com.nekko.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersState
import com.nekko.android.data.PhonePrefs
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.MicHardware
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.RelayState
import com.nekko.protocol.SkillSummary
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Android wrapper around [ChatController]: wires it to the repository's state and events. */
class ChatViewModel(
    private val sessionId: String,
    private val repo: ComputersRepository,
    /** The phone's microphone and its settings; null keeps dictation off (tests, previews). */
    mic: MicHardware? = null,
    phonePrefs: PhonePrefs? = null,
) : ViewModel() {
    private val controller = ChatController(sessionId, repo.caller, viewModelScope, { env(repo.state.value) })

    /** Dictation into this chat's message box (Settings → Dictation). */
    val dictation: DictationController? = if (mic == null || phonePrefs == null) null else DictationController(
        scope = viewModelScope,
        caller = repo.caller,
        hardware = mic,
        settings = { phonePrefs.get(Dictation.ENGINE) to phonePrefs.get(Dictation.LANGUAGE) },
        computer = {
            val s = repo.state.value
            DictationController.computerVoice(repo.caller, s.conn == RelayState.ONLINE, s.pcSettings.voiceEnabled)
        },
        computerName = { repo.state.value.active?.name ?: "your computer" },
    )

    override fun onCleared() {
        dictation?.cancel()
    }

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

    /** When this chat was completed on the computer; null while it is active. */
    val completedAt: StateFlow<Long?> = repo.state.map { s -> s.summaries.firstOrNull { it.id == sessionId }?.archivedAt }
        .distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, repo.state.value.summaries.firstOrNull { it.id == sessionId }?.archivedAt)

    /** Bring this completed chat back to the active list. */
    suspend fun restore() = repo.restoreChat(sessionId)

    suspend fun send(text: String, skill: SkillSummary? = null) = controller.send(text, skill)
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
