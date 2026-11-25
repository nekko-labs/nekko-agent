package com.nekko.android.chat

import com.nekko.protocol.AgentEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Streamed words, applied once per frame instead of once per token. A model can send tens of
 * tokens a second and a fast one more than a screen draws; each applied delta publishes a new chat
 * state and projects it again, so the words that arrive between two frames are joined into one
 * delta and applied together (the order of events is kept: anything else flushes the words first).
 *
 * [frame] suspends until the next frame (`awaitFrame`); [apply] folds one event into the chat.
 * Used from one coroutine, the view model's event collector, on the main thread.
 */
internal class DeltaCoalescer(
    private val scope: CoroutineScope,
    private val sessionId: String,
    private val frame: suspend () -> Unit,
    private val apply: (AgentEvent) -> Unit,
) {
    private var pending: AgentEvent? = null
    private var job: Job? = null

    fun accept(e: AgentEvent) {
        val held = pending
        when {
            e is AgentEvent.Text && e.sessionId == sessionId -> {
                if (held is AgentEvent.Text) pending = e.copy(delta = held.delta + e.delta)
                else { flush(); pending = e; schedule() }
            }
            e is AgentEvent.Reasoning && e.sessionId == sessionId -> {
                if (held is AgentEvent.Reasoning) pending = e.copy(delta = held.delta + e.delta)
                else { flush(); pending = e; schedule() }
            }
            else -> {
                flush()
                apply(e)
            }
        }
    }

    /** Applies the words held so far, now. */
    fun flush() {
        val held = pending ?: return
        pending = null
        apply(held)
    }

    private fun schedule() {
        if (job?.isActive == true) return
        job = scope.launch {
            frame()
            flush()
        }
    }
}
