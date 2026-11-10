package com.nekko.android.voice

/** Split long replies at word boundaries for TextToSpeech's input cap, never through a surrogate pair. */
object VoiceSpeech {
    fun chunks(text: String, limit: Int): List<String> {
        require(limit >= 2)
        val out = mutableListOf<String>()
        var start = 0
        while (start < text.length) {
            var end = minOf(start + limit, text.length)
            if (end < text.length) {
                val word = (end - 1 downTo start + limit / 2).firstOrNull { text[it].isWhitespace() }
                if (word != null) end = word + 1
                if (text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end--
            }
            out += text.substring(start, end)
            start = end
        }
        return out
    }
}
