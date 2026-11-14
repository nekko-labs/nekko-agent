package com.nekko.protocol

/**
 * The continuation envelope a computer sends when it compacts a long chat, recognised for display
 * only (the iPhone's ConversationContext, #2452; Android #2453). The original message stays as it
 * is for the model, copying and expanding. Never an arbitrary heading: only this exact opening.
 */
object ConversationContext {
    private const val OPENING = "Summary of the earlier conversation, compacted to save context:"
    private const val SEPARATOR = "\n\n---\n\n"

    /**
     * The summary, and the user's own prompt when the computer merged it in after the summary.
     * The last separator splits them, so a rule inside the summary stays in the summary. Null when
     * the text isn't a continuation envelope.
     */
    fun parts(text: String): Pair<String, String?>? {
        if (!text.trim().startsWith(OPENING)) return null
        val at = text.lastIndexOf(SEPARATOR)
        if (at < 0) return text to null
        return text.substring(0, at) to text.substring(at + SEPARATOR.length)
    }

    fun isSummary(text: String): Boolean = parts(text) != null
}
