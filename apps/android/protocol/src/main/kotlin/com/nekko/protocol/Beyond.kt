package com.nekko.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.text.Normalizer

// What the phone reads beyond a chat's transcript, as the computer projects it
// for phones (packages/shared/src/phone-views.ts): a chat's queue, the saved
// prompts, and the chat list's search (AN-29, the iPhone's IO-22 to
// IO-25). Mirrors `Beyond.swift`.

/** One prompt waiting in a chat's queue on the computer. */
data class QueuedPrompt(
    /** The text the computer holds: what an edit is checked against (`expect`). */
    val text: String,
    val skillName: String? = null,
    val skillInput: String? = null,
    val images: Int = 0,
) {
    /** What the composer shows: a skill's prompt as `/name input`, never its instructions. */
    val shown: String get() = if (skillName == null) text else "/$skillName ${skillInput.orEmpty()}".trim()

    /** A skill's text is its instructions: it can be removed, not edited. */
    val editable: Boolean get() = skillName == null

    companion object {
        fun list(v: JsonElement?): List<QueuedPrompt> = v.arr().orEmpty().mapNotNull { q ->
            (q as? JsonPrimitive)?.takeIf { it.isString }?.let { return@mapNotNull QueuedPrompt(it.content) }
            val o = q.obj() ?: return@mapNotNull null
            val skill = o["skill"].obj()
            QueuedPrompt(o.str("text").orEmpty(), skill?.str("name"), skill?.str("input"), o["images"].arr()?.size ?: 0)
        }

        /** `chat:editQueued`'s edit: the text the phone showed, and the new text (null removes it). */
        fun edit(expect: String, text: String?): JsonObject = buildJsonObject {
            put("expect", expect)
            text?.let { put("text", it) }
        }
    }
}

/** A prompt the user saved on the computer (`AppSettings.prompts`): its name and text. */
data class SavedPrompt(val id: String, val name: String, val body: String) {
    /** What a turn sends for it, the way the desktop's `/name` does: the text, then what was typed. */
    fun text(input: String): String = listOf(body.trim(), input.trim()).filter { it.isNotEmpty() }.joinToString("\n\n")

    companion object {
        fun list(v: JsonElement?): List<SavedPrompt> = v.arr().orEmpty().mapNotNull { e ->
            val p = e.obj() ?: return@mapNotNull null
            val name = p.str("name")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val body = p.str("body") ?: return@mapNotNull null
            SavedPrompt(p.str("id") ?: name, name, body)
        }
    }
}

/** The chat list's search (the iPhone's `ChatSearch`). */
object ChatSearch {
    /**
     * Chats whose title, first prompt or last reply holds every word of
     * [query], ignoring case and accents. Completed chats included.
     */
    fun matches(chats: List<SessionSummary>, query: String): List<SessionSummary> {
        val words = fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return chats
        return chats.filter { s ->
            val hay = fold(listOf(s.title, s.firstUserText.orEmpty(), s.lastReplyText.orEmpty()).joinToString(" "))
            words.all { hay.contains(it) }
        }
    }

    /** Case, accents and width folded away (`é` → `e`, `Ｅ` → `e`). */
    internal fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").lowercase()
}
