package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/*
 * The one card for all of the computer's chats: the iPhone's Live Activity
 * card (`LiveCard.swift`), which on Android is the keep-alive Live Update
 * notification. Pure state and rules, held to the shared fixture
 * (packages/shared/fixtures/live-card.json) that the iPhone and the
 * computer's Rust port run too. Times are seconds, on any one clock.
 */

enum class LiveLevel(val wire: String) {
    NONE("none"), MINIMAL("minimal"), STANDARD("standard"), DETAILED("detailed");

    companion object {
        fun parse(s: String?): LiveLevel? = entries.firstOrNull { it.wire == s }
    }
}

enum class LiveChatState(val wire: String, val rank: Int) {
    NEEDS_YOU("needsYou", 0), WORKING("working", 1), WATCHING("watching", 2), DONE("done", 3), FAILED("failed", 4);

    val finished: Boolean get() = this == DONE || this == FAILED

    companion object {
        /** A state from a newer computer reads as working, rather than failing the whole card. */
        fun parse(s: String?): LiveChatState = entries.firstOrNull { it.wire == s } ?: WORKING
    }
}

data class LiveChat(
    val id: String,
    /** About 8 characters, for the chip ([LiveCard.shortTitle]). */
    val short: String = "",
    val state: LiveChatState,
    val step: String = "",
    /** The agent's latest reply line (Detailed only). */
    val reply: String = "",
    /** The label of the close button once the chat is finished ([LiveCard.closeWord]). */
    val closeWord: String = "",
    val finishedAt: Double? = null,
    /** When the current run started, for the elapsed time (working or needs you). */
    val startedAt: Double? = null,
    /** The tool call waiting for approval, so the buttons can answer it. */
    val callId: String? = null,
    /** low / medium / high (the computer's guardrail rating). */
    val severity: String? = null,
) {
    companion object {
        /** Anything but the id may be left out; it reads as empty. */
        fun from(e: JsonElement?): LiveChat? {
            val o = e.obj() ?: return null
            return LiveChat(
                id = o.str("id") ?: return null,
                short = o.str("short").orEmpty(),
                state = LiveChatState.parse(o.str("state")),
                step = o.str("step").orEmpty(),
                reply = o.str("reply").orEmpty(),
                closeWord = o.str("closeWord").orEmpty(),
                finishedAt = o.dbl("finishedAt"),
                startedAt = o.dbl("startedAt"),
                callId = o.str("callId"),
                severity = o.str("severity"),
            )
        }
    }
}

data class LiveCardState(
    val chats: List<LiveChat>,
    val focusId: String?,
    /** Chats past the eight the card carries. */
    val more: Int = 0,
    val listening: Boolean = false,
    /** What the mic heard so far (the iPhone's card mic; always empty on Android). */
    val heard: String = "",
) {
    val focused: LiveChat? get() = chats.firstOrNull { it.id == focusId } ?: chats.firstOrNull()

    companion object {
        fun from(e: JsonElement?): LiveCardState {
            val o = e.obj() ?: JsonObject(emptyMap())
            return LiveCardState(
                chats = o["chats"].arr().orEmpty().mapNotNull { LiveChat.from(it) },
                focusId = o.str("focusId"),
                more = (o["more"] as? JsonPrimitive)?.intOrNull ?: 0,
                listening = (o["listening"] as? JsonPrimitive)?.booleanOrNull ?: false,
                heard = (o["heard"] as? JsonPrimitive)?.contentOrNull.orEmpty(),
            )
        }
    }
}

object LiveCard {
    const val MAX_CHATS = 8

    /** A finished chat stays on the card this long (seconds). */
    const val FINISHED_TAIL = 2.0 * 3600

    /**
     * Builds the card from every chat, or null when there is nothing to show
     * (no chats left, or the level is None). The iPhone's `buildCard` without
     * its 4 KB guard: that is ActivityKit's limit, and an Android notification
     * has none.
     */
    fun build(chats: List<LiveChat>, previous: LiveCardState?, pinnedFocus: String?, level: LiveLevel, now: Double): LiveCardState? {
        if (level == LiveLevel.NONE) return null
        val live = chats.withIndex().filter { (_, c) ->
            val at = c.finishedAt
            !c.state.finished || at == null || now - at <= FINISHED_TAIL
        }
        // Most recent first within a state; ties keep the caller's order.
        val sorted = live.sortedWith(
            compareBy<IndexedValue<LiveChat>> { it.value.state.rank }
                .thenByDescending { it.value.finishedAt ?: Double.NEGATIVE_INFINITY }
                .thenBy { it.index },
        ).map { it.value }
        if (sorted.isEmpty()) return null
        val kept = sorted.take(MAX_CHATS)
        val more = sorted.size - kept.size

        val before = LinkedHashMap<String, LiveChatState>()
        previous?.chats?.forEach { before.putIfAbsent(it.id, it.state) }
        val focus = if (previous != null) kept.firstOrNull { it.state == LiveChatState.NEEDS_YOU && before[it.id] != LiveChatState.NEEDS_YOU }?.id else null
        val pinned = pinnedFocus?.takeIf { id -> kept.any { it.id == id } }

        val shown = kept.map { c ->
            var x = c.copy(step = oneLine(c.step, 60))
            if (level == LiveLevel.MINIMAL) x = x.copy(short = "", step = "")
            if (level != LiveLevel.DETAILED) x = x.copy(reply = "")
            x
        }
        return LiveCardState(shown, focus ?: pinned ?: shown[0].id, more, previous?.listening ?: false, previous?.heard.orEmpty())
    }

    /** `Transcript.oneLine`: whitespace runs folded to one space, at most [max] characters ending in "…". */
    fun oneLine(s: String, max: Int): String {
        val flat = s.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return if (flat.codePointCount(0, flat.length) > max) flat.take(max - 1) + "…" else flat
    }

    /** The first word, plus the second when both fit in 8 characters; a longer first word is cut to 8 and ends in "…". */
    fun shortTitle(title: String): String {
        val words = title.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val first = words.firstOrNull() ?: return ""
        if (first.length > 8) return first.take(8) + "…"
        if (words.size > 1 && first.length + 1 + words[1].length <= 8) return "$first ${words[1]}"
        return first
    }

    private val CLOSE_WORDS = listOf("Looks good", "Cool", "Excellent", "Nice", "Perfect")

    /** "Got it" for a failure, else one of five friendly words picked by an FNV-1a hash of the id. */
    fun closeWord(id: String, failed: Boolean): String {
        if (failed) return "Got it"
        var h = 2166136261u
        for (b in id.encodeToByteArray()) h = (h xor b.toUByte().toUInt()) * 16777619u
        return CLOSE_WORDS[(h % CLOSE_WORDS.size.toUInt()).toInt()]
    }

    /** The card's reply line (Detailed): the first sentence of the agent's latest reply, or its first line, at most 60 characters. */
    fun replyLine(text: String?): String {
        val t = text.orEmpty().trim()
        var end = t.length
        for (i in t.indices) {
            if (t[i] == '\n' || t[i] == '\r') { end = i; break }
            if (t[i] in ".!?" && (i + 1 == t.length || t[i + 1].isWhitespace())) { end = i + 1; break }
        }
        val line = t.substring(0, end).trim()
        return if (line.length > 60) line.take(59).trim() + "…" else line
    }
}
