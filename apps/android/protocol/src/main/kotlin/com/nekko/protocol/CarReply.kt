package com.nekko.protocol

/**
 * What a car reads aloud of a chat's reply (#2782, Android Auto; CarPlay speaks the first 200
 * characters the chat list carries). Plain words only: no code, links or Markdown marks, which
 * a voice would spell out. Never shown on the phone itself.
 */
object CarReply {
    const val MAX = 200

    fun spoken(markdown: String): String {
        var t = markdown
        t = t.replace(Regex("```[\\s\\S]*?(```|$)"), " (code) ")
        t = t.replace(Regex("!\\[[^\\]]*]\\([^)]*\\)"), " ")
        t = t.replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
        t = t.replace(Regex("https?://[^\\s]*[^\\s.,;:!?)]"), "(link)")
        t = t.replace(Regex("`([^`]*)`"), "$1")
        t = t.replace(Regex("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+[.)])\\s+"), "")
        t = t.replace(Regex("[*_~]{1,3}"), "")
        // A heading or a list item ends where its line does: read it as a sentence.
        t = t.lines().map { it.trim() }.filter { it.isNotEmpty() }
            .joinToString(" ") { if (it.last() in ".!?:…") it else "$it." }
        t = t.replace(Regex("\\s+"), " ").trim()
        if (t.length <= MAX) return t
        val cut = t.take(MAX)
        val space = cut.lastIndexOf(' ').takeIf { it > MAX / 2 } ?: MAX
        return cut.take(space).trimEnd(',', ';', ':', ' ') + "…"
    }

    /** The newest assistant reply in a chat, spoken; null when it has none with words. */
    fun latest(messages: List<ChatMessage>): String? =
        messages.lastOrNull { it.role == "assistant" && it.content.isNotBlank() }?.content?.let(::spoken)?.takeIf { it.isNotEmpty() }
}
