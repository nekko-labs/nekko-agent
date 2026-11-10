package com.nekko.android.voice

import com.nekko.android.data.Caller
import com.nekko.protocol.Channels
import com.nekko.protocol.VoiceInstall
import com.nekko.protocol.wavArg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext

/** What the microphone button shows. */
sealed interface MicState {
    data object Idle : MicState

    /**
     * Recording for the computer: [samples] so far (the clock), [level] 0..1. [continuous]: tap
     * mode, which listens until Stop and has no cap; [transcribing] counts its segments on their way.
     */
    data class Recording(val engine: Engine, val samples: Int, val level: Float, val continuous: Boolean = false, val transcribing: Int = 0) : MicState

    /** The computer (or the phone) is turning the speech into text. */
    data class Transcribing(val engine: Engine) : MicState
}

/** The pieces that touch Android, swappable in tests. */
interface MicHardware {
    suspend fun record(onProgress: (samples: Int, level: Float) -> Unit): ShortArray

    /** Continuous recording until [stopRecording]: each read to [onChunk], in order. */
    suspend fun stream(onChunk: (ShortArray) -> Unit, onProgress: (samples: Int, level: Float) -> Unit) {
        throw UnsupportedOperationException("This microphone can only record one clip.")
    }
    fun stopRecording()
    fun phoneAvailable(): Boolean
    suspend fun phoneListen(language: String, onLevel: (Float) -> Unit): String
    fun stopPhone()
}

/**
 * Runs one dictation at a time: picks the engine ([Dictation.engine]), records,
 * gets the text, and hands it to [onText] for the message box. Never sends a
 * message. Lives as long as the chat screen's ViewModel.
 *
 * One-shot ([toggle] with `continuous = false`, the voice sheet): one clip of at most
 * 30 s, or one utterance. Continuous (the composer's mic, the iPhone's tap mode): the
 * microphone stays open until Stop. For the computer, [VoiceSegmenter] cuts the audio
 * at each pause (1.2 s, at most 30 s a segment so one fits a relay frame) and each
 * segment is transcribed in order, one at a time (the computer runs one transcription at
 * a time), its words handed to [onText] as they come; Stop transcribes the last words
 * too. A failing segment says so once per failing run and listening goes on. The phone's
 * recognizer endpoints by itself, so it listens again after each utterance.
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

    // Recorder progress can arrive from IO, including after cancellation.
    private val guard = Any()
    private var generation = 0L
    private var job: Job? = null
    /** Continuous phone listening: Stop was tapped, so no new utterance starts. */
    @Volatile private var stopAsked = false

    /** Tap on the mic: start, or stop and transcribe what was said. */
    fun toggle(continuous: Boolean = false, onText: (String) -> Unit) {
        when (val s = _state.value) {
            MicState.Idle -> start(continuous, onText)
            is MicState.Recording -> {
                stopAsked = true
                if (s.engine == Engine.COMPUTER) hardware.stopRecording() else hardware.stopPhone()
            }
            is MicState.Transcribing -> Unit
        }
    }

    /** Leave without keeping anything (screen closed, permission refused). */
    fun cancel() = synchronized(guard) {
        generation++
        val old = job
        job = null
        old?.cancel()
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

    private fun start(continuous: Boolean, onText: (String) -> Unit) {
        val next = synchronized(guard) {
            // Idle also covers the computer probe. Reserve the job before it can run.
            if (job != null) return
            val run = ++generation
            stopAsked = false
            _error.value = null
            scope.launch(start = CoroutineStart.LAZY) {
                val context = currentCoroutineContext()
                try {
                    current(run, context) { }
                    val (choice, language) = settings()
                    val pc = if (choice == EngineChoice.PHONE) ComputerVoice.UNKNOWN else computer()
                    current(run, context) { }
                    val phone = hardware.phoneAvailable()
                    val engine = Dictation.engine(choice, pc, phone)
                    if (engine == null) {
                        current(run, context) { _error.value = Dictation.why(choice, pc, phone, computerName()) }
                        return@launch
                    }
                    if (continuous) {
                        when (engine) {
                            Engine.COMPUTER -> listenViaComputer(run, context, onText)
                            Engine.PHONE -> listenViaPhone(run, context, language, onText)
                        }
                        return@launch
                    }
                    val text = when (engine) {
                        Engine.COMPUTER -> viaComputer(run, context)
                        Engine.PHONE -> {
                            current(run, context) { _state.value = MicState.Recording(Engine.PHONE, 0, 0f) }
                            hardware.phoneListen(language) { lvl -> progress(run, context, Engine.PHONE, 0, lvl) }
                        }
                    }
                    current(run, context) {
                        if (text != null) {
                            // Silence comes back as "[BLANK_AUDIO]" and the like: that is nothing heard.
                            if (Dictation.clean(text).isEmpty()) _error.value = "Didn’t catch anything. Try again a little closer to the phone."
                            else onText(text)
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    current(run, context) { _error.value = e.message?.takeIf { it.isNotBlank() } ?: "Dictation failed." }
                } finally {
                    synchronized(guard) {
                        if (generation == run) {
                            job = null
                            _state.value = MicState.Idle
                        }
                    }
                }
            }.also { job = it }
        }
        next.start()
    }

    /** Check both coroutine cancellation and ownership, even after a noncooperative suspension. */
    private fun <T> current(run: Long, context: CoroutineContext, action: () -> T): T = synchronized(guard) {
        context.ensureActive()
        if (generation != run) throw CancellationException("Dictation was cancelled.")
        action()
    }

    private fun progress(run: Long, context: CoroutineContext, engine: Engine, samples: Int, level: Float) = synchronized(guard) {
        if (generation == run && context.isActive) {
            _state.update { if (it is MicState.Recording && it.engine == engine) it.copy(samples = samples, level = level) else it }
        }
    }

    /** Record, then send the WAV to the computer's Whisper. Null when too short to be speech. */
    private suspend fun viaComputer(run: Long, context: CoroutineContext): String? {
        current(run, context) { _state.value = MicState.Recording(Engine.COMPUTER, 0, 0f) }
        val samples = hardware.record { n, lvl -> progress(run, context, Engine.COMPUTER, n, lvl) }
        current(run, context) {
            if (samples.size < Wav.MIN_SAMPLES) {
                _error.value = "That was too short. Hold on a moment longer."
            } else {
                _state.value = MicState.Transcribing(Engine.COMPUTER)
            }
        }
        if (samples.size < Wav.MIN_SAMPLES) return null
        // Whisper on a laptop CPU takes a few seconds per 30 s of audio; allow for a cold start.
        val wav = wavArg(Wav.encode(samples))
        current(run, context) { }
        val reply = caller.callWithTimeout(TRANSCRIBE_TIMEOUT_MS, Channels.VOICE_TRANSCRIBE, wav)
        current(run, context) { }
        return (reply as? JsonPrimitive)?.contentOrNull.orEmpty()
    }

    /**
     * Tap mode on the computer: record until Stop, cut at each pause, transcribe each segment in
     * order while listening goes on. Returns once the last segment's words are in.
     */
    private suspend fun listenViaComputer(run: Long, context: CoroutineContext, onText: (String) -> Unit) = coroutineScope {
        current(run, context) { _state.value = MicState.Recording(Engine.COMPUTER, 0, 0f, continuous = true) }
        val segments = Channel<FloatArray>(Channel.UNLIMITED)
        val queued = AtomicInteger(0)
        var failing = false
        fun showQueue() = synchronized(guard) {
            if (generation == run) _state.update { if (it is MicState.Recording) it.copy(transcribing = queued.get()) else it }
        }
        // One at a time, in spoken order: the computer refuses a second transcription while one runs.
        val transcriber = launch {
            for (segment in segments) {
                try {
                    val wav = wavArg(Wav.encode(Wav.pcm(segment)))
                    current(run, context) { }
                    val reply = caller.callWithTimeout(TRANSCRIBE_TIMEOUT_MS, Channels.VOICE_TRANSCRIBE, wav)
                    current(run, context) {
                        failing = false
                        val words = (reply as? JsonPrimitive)?.contentOrNull.orEmpty()
                        if (Dictation.clean(words).isNotEmpty()) onText(words)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Said once per failing run, not on every pause; listening goes on.
                    current(run, context) {
                        if (!failing) _error.value = "Couldn’t turn speech into text: ${e.message ?: "the computer didn’t answer."}"
                        failing = true
                    }
                } finally {
                    queued.decrementAndGet()
                    showQueue()
                }
            }
        }
        val segmenter = VoiceSegmenter(Wav.SAMPLE_RATE, SILENCE_SECONDS, Wav.MAX_SECONDS.toDouble(), THRESHOLD)
        fun enqueue(segment: FloatArray) {
            queued.incrementAndGet()
            segments.trySend(segment)
            showQueue()
        }
        try {
            // The recording thread feeds the segmenter alone, in order; the flush below runs after it ends.
            hardware.stream(
                onChunk = { chunk -> segmenter.feed(chunk)?.let(::enqueue) },
                onProgress = { n, lvl -> progress(run, context, Engine.COMPUTER, n, lvl) },
            )
            // Stop: the words said since the last pause count too.
            while (true) enqueue(segmenter.flush() ?: break)
            current(run, context) { if (queued.get() > 0) _state.value = MicState.Transcribing(Engine.COMPUTER) }
        } finally {
            segments.close()
        }
        transcriber.join()
    }

    /** Tap mode on the phone: one utterance after another until Stop; each one's words as they come. */
    private suspend fun listenViaPhone(run: Long, context: CoroutineContext, language: String, onText: (String) -> Unit) {
        current(run, context) { _state.value = MicState.Recording(Engine.PHONE, 0, 0f, continuous = true) }
        var heard = false
        while (true) {
            val text = hardware.phoneListen(language) { lvl -> progress(run, context, Engine.PHONE, 0, lvl) }
            current(run, context) {
                if (Dictation.clean(text).isNotEmpty()) {
                    heard = true
                    onText(text)
                }
            }
            if (stopAsked) break
            // An immediate "no match" must not spin.
            delay(PHONE_RELISTEN_MS)
            if (stopAsked) break
        }
        if (!heard) current(run, context) { _error.value = "Didn’t catch anything. Try again a little closer to the phone." }
    }

    companion object {
        /** The desktop's and the iPhone's: 1.2 s of quiet ends a segment, at sensitivity 60. */
        const val SILENCE_SECONDS = 1.2
        const val THRESHOLD = 0.023f
        const val PHONE_RELISTEN_MS = 200L

        // Host: up to 105 s cold start + 120 s inference, with room for relay transport.
        const val TRANSCRIBE_TIMEOUT_MS = 300_000L

        /** Ask the computer whether its Whisper can take a recording. */
        suspend fun computerVoice(caller: Caller, online: Boolean, enabled: Boolean): ComputerVoice {
            if (!online) return ComputerVoice.UNKNOWN
            val install = try {
                VoiceInstall.from(caller.call(Channels.VOICE_STATUS))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
            currentCoroutineContext().ensureActive()
            if (install == null) return ComputerVoice(online = true, installed = false, enabled = enabled)
            return ComputerVoice(online = true, installed = install.installed, enabled = enabled)
        }
    }
}
