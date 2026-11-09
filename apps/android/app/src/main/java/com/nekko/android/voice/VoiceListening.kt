package com.nekko.android.voice

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Explicitly started continuous command/dictation capture, or one held utterance. Main-thread core. */
class VoiceListening(private val scope: CoroutineScope, private val runner: VoiceRunner) {
    data class IO(
        val capture: suspend () -> String,
        /** Normal release asks for the final transcript; abort must NOT use this. */
        val finishCapture: () -> Unit,
        val stopAudio: () -> Unit,
        val allowed: () -> Boolean = { true },
    )
    data class State(val active: Boolean = false, val finishing: Boolean = false, val error: String? = null)
    private val mutableState = MutableStateFlow(State())
    val state = mutableState.asStateFlow()
    private var job: Job? = null
    private var io: IO? = null
    private var generation = 0L
    private var finishing = false
    private var finishSignal: CompletableDeferred<Unit>? = null

    fun start(audio: IO, held: Boolean = false) {
        if (job != null || !audio.allowed()) return
        val run = ++generation
        io = audio
        finishing = false
        val release = CompletableDeferred<Unit>()
        finishSignal = release
        runner.started()
        mutableState.value = State(active = true)
        val next = scope.launch(start = CoroutineStart.LAZY) {
            suspend fun current() {
                currentCoroutineContext().ensureActive()
                if (generation != run || !audio.allowed()) throw CancellationException("Voice listening stopped.")
            }
            try {
                // A normal Stop may arrive before the lazy capture coroutine is first dispatched.
                if (finishing) { runner.stopped(afterHold = held); return@launch }
                do {
                    current()
                    val words = withTimeout(VoiceConversation.CAPTURE_TIMEOUT_MS) { audio.capture() }
                    current()
                    // Android may endpoint before the finger lifts. Never execute a held command early.
                    if (held && !finishing) withTimeout(VoiceConversation.CAPTURE_TIMEOUT_MS) { release.await() }
                    current()
                    if (words.isNotBlank()) runner.hear(words)
                    current()
                    if (held || finishing) break
                    // Avoid a tight loop if the system reports immediate silence/no match.
                    delay(200)
                    if (finishing) break
                } while (true)
                runner.stopped(afterHold = held)
            } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
                if (generation == run) { runner.abort(); mutableState.value = State(error = "Voice timed out. Tap Start to try again.") }
            } catch (e: CancellationException) { if (generation == run) runner.abort(); throw e }
            catch (e: Exception) {
                if (generation == run) { runner.abort(); mutableState.value = State(error = e.message ?: "Voice listening failed.") }
            } finally {
                if (generation == run) {
                    audio.stopAudio(); io = null; job = null; finishSignal = null
                    mutableState.value = mutableState.value.copy(active = false, finishing = false)
                }
            }
        }
        job = next
        next.start()
    }

    /** A normal release drains its last transcript in order. Call only after HoldToTalk returns FINISH. */
    fun finish() {
        if (job == null) return
        finishing = true
        mutableState.value = mutableState.value.copy(finishing = true)
        io?.finishCapture?.invoke()
        finishSignal?.complete(Unit)
    }

    /** Lock, background, permission loss, target change, short hold or gesture cancellation: discard. */
    fun abort() {
        generation++
        val previous = job
        job = null
        previous?.cancel()
        finishSignal = null
        io?.stopAudio?.invoke(); io = null
        runner.abort()
        mutableState.value = State()
    }
}
