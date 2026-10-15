package com.nekko.android.voice

import com.nekko.android.data.Caller
import com.nekko.protocol.Channels
import com.nekko.protocol.VoiceInstall
import com.nekko.protocol.wavArg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What the microphone button shows. */
sealed interface MicState {
    data object Idle : MicState

    /** Recording for the computer: [samples] so far (the clock), [level] 0..1. */
    data class Recording(val engine: Engine, val samples: Int, val level: Float) : MicState

    /** The computer (or the phone) is turning the speech into text. */
    data class Transcribing(val engine: Engine) : MicState
}

/** The pieces that touch Android, swappable in tests. */
interface MicHardware {
    suspend fun record(onProgress: (samples: Int, level: Float) -> Unit): ShortArray
    fun stopRecording()
    fun phoneAvailable(): Boolean
    suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String
    fun stopPhone()
}

/**
 * Runs one dictation at a time: picks the engine ([Dictation.engine]), records,
 * gets the text, and hands it to [onText] for the message box. Never sends a
 * message. Lives as long as the chat screen's ViewModel.
 */
class DictationController(
    private val scope: CoroutineScope,
    private val caller: Caller,
    private val hardware: MicHardware,
    /** The engine choice and phone language, read at the moment the mic is tapped. */
    private val settings: () -> Pair<EngineChoice, String>,
    /** What the computer said about Nekko Voice right now. */
    private val computer: suspend () -> ComputerVoice,
    /** The paired computer's name, for messages ("Transcribing on Mac…"). */
    val computerName: () -> String,
) {
    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    val state: StateFlow<MicState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var job: Job? = null

    /** Tap on the mic: start, or stop and transcribe what was said. */
    fun toggle(onText: (String) -> Unit) {
        when (val s = _state.value) {
            MicState.Idle -> start(onText)
            is MicState.Recording -> if (s.engine == Engine.COMPUTER) hardware.stopRecording() else hardware.stopPhone()
            is MicState.Transcribing -> Unit
        }
    }

    /** Leave without keeping anything (screen closed, permission refused). */
    fun cancel() {
        job?.cancel()
        hardware.stopRecording()
        hardware.stopPhone()
        _state.value = MicState.Idle
    }

    /** The user refused the microphone permission. */
    fun denied() {
        _error.value = "Nekko needs the microphone to dictate. Allow it in the phone’s Settings → Apps → Nekko Agent → Permissions."
    }

    fun clearError() {
        _error.value = null
    }

    private fun start(onText: (String) -> Unit) {
        _error.value = null
        job = scope.launch {
            try {
                val (choice, language) = settings()
                val pc = if (choice == EngineChoice.PHONE) ComputerVoice.UNKNOWN else computer()
                val phone = hardware.phoneAvailable()
                val engine = Dictation.engine(choice, pc, phone)
                if (engine == null) {
                    _error.value = Dictation.why(choice, pc, phone, computerName())
                    return@launch
                }
                val text = when (engine) {
                    Engine.COMPUTER -> viaComputer()
                    Engine.PHONE -> {
                        _state.value = MicState.Recording(Engine.PHONE, 0, 0f)
                        hardware.phoneListen(language) { lvl -> _state.update { if (it is MicState.Recording) it.copy(level = lvl) else it } }
                    }
                }
                if (text != null) {
                    // Silence comes back as "[BLANK_AUDIO]" and the like: that is nothing heard.
                    if (Dictation.clean(text).isEmpty()) _error.value = "Didn’t catch anything. Try again a little closer to the phone."
                    else onText(text)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e.message?.takeIf { it.isNotBlank() } ?: "Dictation failed."
            } finally {
                _state.value = MicState.Idle
            }
        }
    }

    /** Record, then send the WAV to the computer's Whisper. Null when too short to be speech. */
    private suspend fun viaComputer(): String? {
        _state.value = MicState.Recording(Engine.COMPUTER, 0, 0f)
        val samples = hardware.record { n, lvl -> _state.value = MicState.Recording(Engine.COMPUTER, n, lvl) }
        if (samples.size < Wav.MIN_SAMPLES) {
            _error.value = "That was too short. Hold on a moment longer."
            return null
        }
        _state.value = MicState.Transcribing(Engine.COMPUTER)
        // Whisper on a laptop CPU takes a few seconds per 30 s of audio; allow for a cold start.
        val reply = caller.callWithTimeout(TRANSCRIBE_TIMEOUT_MS, Channels.VOICE_TRANSCRIBE, wavArg(Wav.encode(samples)))
        return (reply as? JsonPrimitive)?.contentOrNull.orEmpty()
    }

    companion object {
        const val TRANSCRIBE_TIMEOUT_MS = 150_000L

        /** Ask the computer whether its Whisper can take a recording. */
        suspend fun computerVoice(caller: Caller, online: Boolean, enabled: Boolean): ComputerVoice {
            if (!online) return ComputerVoice.UNKNOWN
            val install = runCatching { VoiceInstall.from(caller.call(Channels.VOICE_STATUS)) }.getOrNull()
                ?: return ComputerVoice(online = true, installed = false, enabled = enabled)
            return ComputerVoice(online = true, installed = install.installed, enabled = enabled)
        }
    }
}
