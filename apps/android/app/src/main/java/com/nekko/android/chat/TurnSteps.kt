package com.nekko.android.chat

import com.nekko.protocol.AgentRows
import com.nekko.protocol.Block

/**
 * Simple's folded steps: each turn's reasoning and tool calls become one line ("Took 4 steps · 12s")
 * that opens in place. A step is a tool call or a reply's reasoning. Pure, so it runs on the JVM.
 */
object TurnSteps {
    sealed interface Row<T> {
        /** A transcript item; [stepsOpen] when its turn's steps show (its reasoning then shows too). */
        data class Item<T>(val item: T, val stepsOpen: Boolean) : Row<T>

        /** One turn's folded steps, where its first step was. [turn] is that step's key, stable as the turn grows. */
        data class Summary<T>(val turn: String, val steps: Int, val running: Boolean, val durationMs: Long?, val open: Boolean) : Row<T>
    }

    /** A watch's wake-up arrives as a user block, but it is a step of the run, not a new prompt. */
    private fun isWake(b: Block) = b is Block.User && b.thumbs.isEmpty() && AgentRows.parseWake(b.text) != null

    private fun isStep(b: Block) = b is Block.Tool || isWake(b) || (b is Block.Assistant && !b.reasoning.isNullOrEmpty())

    /** A thought with no reply text: nothing left to show once its reasoning is folded. */
    private fun onlyStep(b: Block) = b is Block.Tool || isWake(b) || (b is Block.Assistant && b.text.isBlank() && b.thumbs.isEmpty() && !b.streaming && !b.interrupted)

    /**
     * [items] in order, each turn's steps folded into a [Row.Summary] unless its key is in [open].
     * [running] is whether the last turn is still going.
     */
    fun <T> fold(items: List<T>, block: (T) -> Block, key: (T) -> String, running: Boolean, open: Set<String>): List<Row<T>> {
        // Turns start at each prompt; whatever comes before the first prompt is a turn too.
        val turns = mutableListOf<MutableList<T>>()
        items.forEach { if ((block(it) is Block.User && !isWake(block(it))) || turns.isEmpty()) turns += mutableListOf(it) else turns.last() += it }
        val out = mutableListOf<Row<T>>()
        turns.forEachIndexed { i, turn ->
            val steps = turn.filter { isStep(block(it)) }
            if (steps.isEmpty()) {
                turn.forEach { out += Row.Item(it, stepsOpen = false) }
                return@forEachIndexed
            }
            val id = key(steps.first())
            val isOpen = id in open
            val live = running && i == turns.lastIndex
            val prompt = (block(turn.first()) as? Block.User)?.at
            val last = turn.mapNotNull { (block(it) as? Block.Assistant)?.at }.maxOrNull()
            val duration = if (!live && prompt != null && last != null && last > prompt) last - prompt else null
            turn.forEach { item ->
                if (item === steps.first()) out += Row.Summary(id, steps.size, live, duration, isOpen)
                if (isOpen || !onlyStep(block(item))) out += Row.Item(item, isOpen)
            }
        }
        return out
    }

    /** The label's words: English here, the app's language from the screen. */
    data class Words(val one: String = "1 step", val other: String = "%1\$d steps", val working: String = "Working · %1\$s so far", val took: String = "Took %1\$s")

    /** "Took 4 steps · 12s", or "Working · 2 steps so far" while the turn runs. */
    fun label(steps: Int, running: Boolean, durationMs: Long?, words: Words = Words()): String {
        val count = if (steps == 1) words.one else words.other.format(steps)
        if (running) return words.working.format(count)
        return words.took.format(count) + (durationMs?.let { " · " + duration(it) } ?: "")
    }

    /** 12s, 1m 5s, 2m, 1h 3m. */
    fun duration(ms: Long): String {
        val s = Math.round(ms / 1000.0).coerceAtLeast(1)
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> if (s % 60 == 0L) "${s / 60}m" else "${s / 60}m ${s % 60}s"
            else -> if (s / 60 % 60 == 0L) "${s / 3600}h" else "${s / 3600}h ${s / 60 % 60}m"
        }
    }
}
