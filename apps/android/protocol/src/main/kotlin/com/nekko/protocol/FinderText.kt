package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.text.Normalizer

// The chat list's search inside messages (#3448): what each chat said, as the
// computer sends it to phones (`sessions:finderText`, PHONE_FINDER_VIEW in
// packages/shared/src/phone-access.ts), and the desktop chat finder's match
// and snippet (apps/desktop/src/renderer/views/chatFinder.ts). Mirrors
// `FinderText.swift`.

/** One message a chat's search reads: its text and the files its tool calls named. */
data class FinderMessage(val role: String, val text: String, val files: List<String> = emptyList())

/** What one chat said. */
data class FinderChat(val messages: List<FinderMessage>) {
    companion object {
        /**
         * A `sessions:finderText` reply. A chat the computer doesn't have maps to an empty
         * chat; one it left out (the reply was full) is absent, so it is asked for again.
         */
        fun parse(v: JsonElement?): Map<String, FinderChat> {
            val o = v.obj() ?: return emptyMap()
            return o.mapValues { (_, c) ->
                val chat = c.obj() ?: return@mapValues FinderChat(emptyList())
                FinderChat(chat["messages"].arr().orEmpty().mapNotNull { m ->
                    val mo = m.obj() ?: return@mapNotNull null
                    FinderMessage(
                        role = mo.str("role") ?: return@mapNotNull null,
                        text = mo.str("text").orEmpty(),
                        files = mo["files"].arr().orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString && it !is JsonNull }?.content },
                    )
                })
            }
        }
    }
}

/** A chat the search found, and the line that matched when its title alone did not. */
data class ChatHit(val chat: SessionSummary, val snippet: String? = null)

/** The chat list's search across what chats said ([ChatSearch.matches] reads summaries only). */
object FinderSearch {
    /** Chats one `sessions:finderText` call asks for (`PHONE_FINDER_VIEW.chats`). */
    const val BATCH = 20

    private const val SNIPPET_BEFORE = 24
    private const val SNIPPET_CHARS = 90

    /**
     * Chats holding every word of [query], any case or accent, in order. A word can be in the
     * title, first prompt or last reply ([ChatSearch.matches]) or, for a chat in [texts], in a
     * message or a file it named. A title match needs no snippet; otherwise the snippet is the
     * piece of the summary or of the message where a word the title lacks was found.
     */
    fun hits(chats: List<SessionSummary>, query: String, texts: Map<String, FinderChat>): List<ChatHit> {
        val words = ChatSearch.fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return chats.map { ChatHit(it) }
        return chats.mapNotNull { s -> hit(s, words, texts[s.id]) }
    }

    private fun hit(s: SessionSummary, words: List<String>, text: FinderChat?): ChatHit? {
        val title = ChatSearch.fold(s.title)
        if (words.all { title.contains(it) }) return ChatHit(s)
        val description = listOf(s.firstUserText.orEmpty(), s.lastReplyText.orEmpty()).joinToString("\n")
        val head = title + "\n" + ChatSearch.fold(description)
        val missing = words.filter { !head.contains(it) }
        if (missing.isEmpty()) {
            val word = words.firstOrNull { !title.contains(it) } ?: words[0]
            return ChatHit(s, snippetAround(description, word))
        }
        val messages = text?.messages.orEmpty().map { m -> m to ChatSearch.fold(m.text + "\n" + m.files.joinToString("\n")) }
        if (missing.any { w -> messages.none { (_, f) -> f.contains(w) } }) return null
        // The message holding most of what the summary lacks, the newest of equals.
        val best = messages.withIndex().maxWith(compareBy({ (_, p) -> missing.count { p.second.contains(it) } }, { it.index })).value
        val word = missing.first { best.second.contains(it) }
        val shown = if (ChatSearch.fold(best.first.text).contains(word)) best.first.text else best.first.files.first { ChatSearch.fold(it).contains(word) }
        return ChatHit(s, snippetAround(shown, word))
    }

    /** A short piece of [text] around the first place [word] (folded) appears, as the desktop finder cuts it. */
    fun snippetAround(text: String, word: String): String? {
        val (folded, at) = foldMapped(text)
        val i = folded.indexOf(word)
        if (i < 0) return null
        var start = maxOf(0, at[i] - SNIPPET_BEFORE)
        if (start > 0 && Character.isLowSurrogate(text[start])) start--
        var end = minOf(text.length, start + SNIPPET_CHARS)
        if (end < text.length && Character.isHighSurrogate(text[end - 1])) end--
        val piece = text.substring(start, end).replace(Regex("\\s+"), " ").trim()
        return (if (start > 0) "…" else "") + piece + (if (end < text.length) "…" else "")
    }

    /** [text] folded as [ChatSearch.fold] does, with where each folded character came from. */
    private fun foldMapped(text: String): Pair<String, IntArray> {
        val out = StringBuilder()
        val from = ArrayList<Int>(text.length)
        var i = 0
        while (i < text.length) {
            val n = Character.charCount(text.codePointAt(i))
            val folded = Normalizer.normalize(text.substring(i, i + n), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").lowercase()
            repeat(folded.length) { from += i }
            out.append(folded)
            i += n
        }
        return out.toString() to from.toIntArray()
    }
}
