package com.nekko.android.ui.screens

import com.nekko.protocol.Block
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.Voice
import java.util.IdentityHashMap

/**
 * What the chat screen derives from the blocks, kept between frames. A streamed token changes only
 * the last block, so the earlier blocks keep their keys, their row objects (which let Compose skip
 * the rows it already drew) and their voices, and only the tail is new.
 */
internal class TranscriptCache {
    private var layout = Int.MIN_VALUE
    private var keyed: List<Pair<String, Block>> = emptyList()
    private var rows: List<TranscriptRow> = emptyList()
    private val voices = IdentityHashMap<String, Voice>()

    /**
     * The blocks with their list keys. A provider that reuses a call id across turns gets a suffix.
     * [layout] is `ChatUi.layout`: unchanged means only the last block changed, so its key stays.
     */
    fun keyed(blocks: List<Block>, layout: Int): List<Pair<String, Block>> {
        val prev = keyed
        keyed = if (layout == this.layout && prev.size == blocks.size && blocks.isNotEmpty()) {
            val last = blocks.last()
            if (prev.last().second === last) prev else ArrayList(prev).also { it[it.size - 1] = it[it.size - 1].first to last }
        } else {
            val seen = HashMap<String, Int>()
            blocks.map { b ->
                val kind = when (b) {
                    is Block.User -> "user"
                    is Block.Assistant -> "assistant"
                    is Block.Tool -> "tool"
                }
                val base = "$kind:${b.id}"
                val n = seen.getOrDefault(base, 0)
                seen[base] = n + 1
                (if (n > 0) "$base#$n" else base) to b
            }
        }
        this.layout = layout
        return keyed
    }

    /** [next] with each row that equals the one drawn under its key replaced by that one. */
    fun rows(next: List<TranscriptRow>): List<TranscriptRow> {
        val prev = rows
        if (prev.isEmpty()) return next.also { rows = it }
        val byKey = HashMap<String, TranscriptRow>(prev.size * 2)
        for (r in prev) byKey[rowKey(r)] = r
        var same = next.size == prev.size
        val out = next.mapIndexed { i, r ->
            val p = byKey[rowKey(r)]
            if (p != null && p == r) {
                if (same && prev[i] !== p) same = false
                p
            } else {
                same = false
                r
            }
        }
        rows = if (same) prev else out
        return rows
    }

    /** A note's voice, scanned once per text the cache has seen (the scan is a regex pass). */
    fun midTurnVoice(text: String): Voice {
        voices[text]?.let { return it }
        if (voices.size > 4096) voices.clear()
        return ReplyTopics.midTurnVoice(text).also { voices[text] = it }
    }
}
