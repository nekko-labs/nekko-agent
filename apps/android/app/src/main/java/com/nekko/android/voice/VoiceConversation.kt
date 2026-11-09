package com.nekko.android.voice

import com.nekko.protocol.MarkdownParser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Half-duplex voice. Call on one dispatcher (Main in the app). No audio or transport in the core. */
class VoiceConversation(private val scope: CoroutineScope) {
    enum class Phase { READY, LISTENING, WAITING, SPEAKING, STOPPED }
    data class State(
        val phase: Phase = Phase.READY,
        val active: Boolean = false,
        val heard: String = "",
        val reply: String = "",
        val error: String? = null,
    )

    /** Capture and response are bound to ONE chat/computer when Start is pressed. */
    data class IO(
        val capture: suspend () -> String,
        val respond: suspend (String) -> String,
        val speak: suspend (String) -> Unit,
        val stopAudio: () -> Unit,
        /** Synchronous foreground, unlocked, original-target and connection check. */
        val allowed: () -> Boolean = { true },
    )

    private val mutableState = MutableStateFlow(State())
    val state = mutableState.asStateFlow()
    private var generation = 0L
    private var job: Job? = null
    private var audio: (() -> Unit)? = null

    /** Explicit opt-in only. Duplicate Start cannot overlap a pending startup. */
    fun start(io: IO) {
        if (job != null) return
        if (!io.allowed()) {
            mutableState.value = State(phase = Phase.STOPPED, error = "Unlock and return to the original chat before starting voice.")
            return
        }
        val run = ++generation
        audio = io.stopAudio
        mutableState.value = State(active = true)
        val next = scope.launch(start = CoroutineStart.LAZY) {
            suspend fun current() {
                currentCoroutineContext().ensureActive()
                if (generation != run) throw CancellationException("Voice stopped.")
                check(io.allowed()) { "Voice stopped. Return to the original chat and tap Start again." }
            }
            try {
                while (true) {
                    current()
                    mutableState.value = mutableState.value.copy(phase = Phase.LISTENING)
                    val words = withTimeout(CAPTURE_TIMEOUT_MS) { io.capture() }.trim()
                    current()
                    check(words.isNotEmpty()) { "No speech was heard. Tap Start to try again." }
                    mutableState.value = mutableState.value.copy(heard = words, phase = Phase.WAITING)
                    val answer = withTimeout(REPLY_TIMEOUT_MS) { io.respond(words) }
                    current()
                    val reply = MarkdownParser.plainText(answer).trim()
                    check(reply.isNotEmpty()) { "There is no spoken reply. Check the chat before continuing." }
                    mutableState.value = mutableState.value.copy(reply = reply, phase = Phase.SPEAKING)
                    withTimeout(SPEAK_TIMEOUT_MS) { io.speak(reply) }
                    current()
                }
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                if (generation == run) mutableState.value = mutableState.value.copy(error = "Voice timed out. Check the chat before starting again.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (generation == run) mutableState.value = mutableState.value.copy(error = e.message ?: "Voice stopped.")
            } finally {
                // A cancelled, noncooperative callback must not close a newer run's audio.
                if (generation == run) {
                    audio?.invoke()
                    audio = null
                    job = null
                    mutableState.value = mutableState.value.copy(phase = Phase.STOPPED, active = false)
                }
            }
        }
        job = next
        next.start()
    }

    /** Discards unsent speech. An agent task already sent is NOT cancelled. Never auto-resumes. */
    fun stop() {
        generation++
        val previous = job
        job = null
        previous?.cancel()
        audio?.invoke()
        audio = null
        mutableState.value = mutableState.value.copy(phase = Phase.STOPPED, active = false)
    }

    /** Feed immediately on lock, background, disconnect, target change or audio interruption. */
    fun safetyChanged(allowed: Boolean) { if (!allowed) stop() }

    companion object {
        const val CAPTURE_TIMEOUT_MS = 40_000L
        const val REPLY_TIMEOUT_MS = 300_000L
        const val SPEAK_TIMEOUT_MS = 120_000L
    }
}
