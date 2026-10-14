package com.nekko.android.share

/**
 * Text another app shared with Nekko (Android's share sheet, `ACTION_SEND`
 * `text/plain`): a page link, a selection, a note. It only ever pre-fills a new
 * chat; nothing is sent until the user presses Send.
 *
 * Pure so it is tested on the JVM; MainActivity feeds it the intent extras.
 */
object SharedText {
    /** Longer shares are cut here (a whole article pasted by mistake should not stall the composer). */
    const val MAX_CHARS = 20_000

    /** Appended when a share was cut at [MAX_CHARS]. */
    const val CUT_NOTE = "\n\n[…shortened by Nekko: the shared text was longer than 20,000 characters]"

    /**
     * The prompt to pre-fill, or null when there is nothing usable. Browsers send
     * the page title as the subject and the link as the text; the subject is
     * kept above the text unless the text already contains it.
     */
    fun from(type: String?, text: CharSequence?, subject: CharSequence?): String? {
        if (type != null && !type.startsWith("text/")) return null
        val body = clean(text)
        val title = clean(subject)?.takeUnless { body != null && body.contains(it) }
        val joined = listOfNotNull(title, body).joinToString("\n\n").ifEmpty { return null }
        return if (joined.length <= MAX_CHARS) joined else cut(joined)
    }

    private fun clean(s: CharSequence?): String? =
        s?.toString()
            ?.replace("\r\n", "\n")
            // Control characters other than newline and tab never belong in a prompt.
            ?.filter { it == '\n' || it == '\t' || !it.isISOControl() }
            ?.trim()
            ?.ifEmpty { null }

    /** Cut without splitting a surrogate pair (an emoji), then say so. */
    private fun cut(s: String): String {
        var end = MAX_CHARS
        if (Character.isHighSurrogate(s[end - 1])) end--
        return s.substring(0, end).trimEnd() + CUT_NOTE
    }
}
