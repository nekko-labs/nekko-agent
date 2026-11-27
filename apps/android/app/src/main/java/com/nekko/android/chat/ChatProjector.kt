package com.nekko.android.chat

import com.nekko.protocol.Block
import com.nekko.protocol.QuestionReplies
import com.nekko.protocol.Session
import com.nekko.protocol.Transcript
import com.nekko.protocol.TurnDetails
import com.nekko.protocol.TurnStrategy

/**
 * The blocks and footers [ChatController.project] shows, kept between calls so a streamed token
 * costs one reply's worth of work, not the whole chat's (the iPhone's `ChatModel`: parse the saved
 * transcript once per read, patch only the live tail).
 *
 * - The saved transcript and the turn footers are parsed once per [Session] instance, not per token.
 * - While a turn streams, a token that only grew the turn's last reply replaces just the last block
 *   of the previous result. Anything else (a tool call, a result, the end of the turn) merges again.
 * - [layout] changes whenever the blocks changed anywhere but the last one, so the screen can keep
 *   what it derived from the earlier blocks (keys, rows, voices) across streamed tokens.
 *
 * Not thread safe: one projector per chat, used from one thread (the view model's collector).
 */
class ChatProjector {
    private var savedFor: Session? = null
    private var saved: List<Block> = emptyList()
    /** [saved] after [QuestionReplies], for a chat with no live turn. */
    private var savedShown: List<Block> = emptyList()
    private var savedReplies: Set<String> = emptySet()
    var footers: Map<String, TurnDetails> = emptyMap()
        private set

    var strategies: Map<String, TurnStrategy> = emptyMap()
        private set

    private var lastLive: List<Block>? = null
    private var lastMerged: List<Block> = emptyList()

    /** Bumped when the blocks changed anywhere but the last block. */
    var layout: Int = 0
        private set

    /** How many times the saved transcript was parsed (read by tests). */
    var parses: Int = 0
        private set

    /** The blocks to show for [session] with [live] laid over it. */
    fun blocks(session: Session?, live: List<Block>): List<Block> {
        if (session !== savedFor) {
            savedFor = session
            saved = session?.let { Transcript.fromMessages(it.messages) } ?: emptyList()
            savedShown = QuestionReplies.project(saved)
            // Replies this turn's saved blocks already hold (what mergeLive hides from the live overlay).
            val lastUser = saved.indexOfLast { it is Block.User }
            savedReplies = saved.drop(lastUser + 1).filterIsInstance<Block.Assistant>().mapTo(HashSet()) { it.text.trim() }
            footers = session?.let { TurnDetails.footers(it.messages) } ?: emptyMap()
            strategies = session?.let { TurnStrategy.sections(it.messages) } ?: emptyMap()
            lastLive = null
            parses++
        }
        val next: List<Block>
        var patched = false
        val before = lastLive
        if (live.isEmpty()) {
            next = savedShown
        } else if (before === live) {
            next = lastMerged
        } else if (before != null && onlyLastReplyGrew(before, live)) {
            next = ArrayList(lastMerged).also { it[it.size - 1] = live.last() }
            patched = true
        } else {
            next = QuestionReplies.project(Transcript.mergeLive(saved, live))
        }
        if (!patched && next !== lastMerged) layout++
        lastMerged = next
        lastLive = live
        return next
    }

    /**
     * [live] is [before] with its last reply grown, and the merge would keep that reply as it is the
     * last block shown: the whole merge would come out as the last one with that block swapped.
     */
    private fun onlyLastReplyGrew(before: List<Block>, live: List<Block>): Boolean {
        if (before.size != live.size) return false
        val last = live.last() as? Block.Assistant ?: return false
        val was = before.last() as? Block.Assistant ?: return false
        if (was.id != last.id || lastMerged.lastOrNull() !== was) return false
        for (i in 0 until live.size - 1) if (before[i] !== live[i]) return false
        return last.text.isBlank() || last.text.trim() !in savedReplies
    }
}
