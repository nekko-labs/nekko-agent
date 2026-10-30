package com.nekko.protocol

/**
 * Enough Markdown for agent replies, without a dependency, matching the iPhone
 * app's `MarkdownText.parse`: fenced code blocks, headings, bullet, task and
 * numbered lists, quotes, rules and paragraphs; inside them bold, italic,
 * inline code and links. Links are shown, never fetched, and images are never
 * loaded: `![alt](url)` stays its alt text.
 */
object Markdown {
    sealed interface Piece {
        data class Code(val language: String, val code: String) : Piece
        data class Heading(val level: Int, val text: String) : Piece
        data class Bullet(val indent: Int, val marker: String, val text: String) : Piece
        data class Quote(val text: String) : Piece
        data object Rule : Piece
        data class Paragraph(val text: String) : Piece
    }

    enum class Style { BOLD, ITALIC, CODE, LINK, STRIKE }

    /** A run of inline text; [url] is set for [Style.LINK]. */
    data class Span(val text: String, val styles: Set<Style> = emptySet(), val url: String? = null)

    fun parse(text: String): List<Piece> {
        val out = mutableListOf<Piece>()
        val para = mutableListOf<String>()
        var fenceLang: String? = null
        val fence = mutableListOf<String>()
        fun flush() {
            if (para.isNotEmpty()) out += Piece.Paragraph(para.joinToString("\n"))
            para.clear()
        }
        for (raw in text.split("\n")) {
            val line = raw.trim()
            if (fenceLang != null) {
                if (line.startsWith("```")) {
                    out += Piece.Code(fenceLang, fence.joinToString("\n"))
                    fence.clear()
                    fenceLang = null
                } else {
                    fence += raw
                }
                continue
            }
            if (line.startsWith("```")) {
                flush()
                fenceLang = line.removePrefix("```").trim()
                continue
            }
            if (line.isEmpty()) {
                flush()
                continue
            }
            val hashes = line.takeWhile { it == '#' }.length
            if (hashes in 1..6 && line.length > hashes && line[hashes] == ' ') {
                flush()
                out += Piece.Heading(hashes, line.substring(hashes).trim())
                continue
            }
            if (line == "---" || line == "***" || line == "___") {
                flush()
                out += Piece.Rule
                continue
            }
            if (line.startsWith("> ")) {
                flush()
                out += Piece.Quote(line.substring(2))
                continue
            }
            val indent = raw.takeWhile { it == ' ' }.length / 2
            if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) {
                flush()
                var body = line.substring(2)
                var marker = "•"
                if (body.startsWith("[ ] ")) {
                    marker = "☐"; body = body.substring(4)
                } else if (body.startsWith("[x] ") || body.startsWith("[X] ")) {
                    marker = "☑"; body = body.substring(4)
                }
                out += Piece.Bullet(indent, marker, body)
                continue
            }
            val dot = line.indexOf('.')
            if (dot > 0 && line.substring(0, dot).all { it.isDigit() } && dot + 1 < line.length && line[dot + 1] == ' ') {
                flush()
                out += Piece.Bullet(indent, line.substring(0, dot + 1), line.substring(dot + 2))
                continue
            }
            para += raw
        }
        // A reply still streaming can end inside a fence; show what has arrived.
        if (fenceLang != null) out += Piece.Code(fenceLang, fence.joinToString("\n"))
        flush()
        return out
    }

    /**
     * Inline styling. Unclosed markers stay literal text, so a reply that is
     * still streaming (`**bo`) never swallows what follows. Backslash escapes
     * the next punctuation character.
     */
    fun inline(text: String): List<Span> {
        val out = mutableListOf<Span>()
        val buf = StringBuilder()
        fun emit(styles: Set<Style>) {
            if (buf.isEmpty()) return
            val last = out.lastOrNull()
            if (last != null && last.styles == styles && last.url == null) {
                out[out.size - 1] = last.copy(text = last.text + buf)
            } else {
                out += Span(buf.toString(), styles)
            }
            buf.clear()
        }

        fun walk(s: String, styles: Set<Style>) {
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '\\' && i + 1 < s.length && s[i + 1] in PUNCT) {
                    buf.append(s[i + 1]); i += 2; continue
                }
                if (c == '`') {
                    val end = s.indexOf('`', i + 1)
                    if (end > i + 1) {
                        emit(styles)
                        out += Span(s.substring(i + 1, end), styles + Style.CODE)
                        i = end + 1
                        continue
                    }
                }
                if (c == '!' && i + 1 < s.length && s[i + 1] == '[') {
                    val link = linkAt(s, i + 1)
                    if (link != null) {
                        // Images are never loaded on the phone; the alt text stands in.
                        buf.append(link.first.ifEmpty { "image" })
                        i = link.third
                        continue
                    }
                }
                if (c == '[') {
                    val link = linkAt(s, i)
                    if (link != null) {
                        emit(styles)
                        val (label, url, next) = link
                        val before = out.size
                        walk(label, styles + Style.LINK)
                        emit(styles + Style.LINK)
                        for (k in before until out.size) out[k] = out[k].copy(styles = out[k].styles + Style.LINK, url = url)
                        i = next
                        continue
                    }
                }
                if (c == '~' && i + 1 < s.length && s[i + 1] == '~') {
                    // ~~strikethrough~~, as the desktop and the iPhone draw it.
                    val start = i + 2
                    val end = if (start < s.length && !s[start].isWhitespace()) s.indexOf("~~", start) else -1
                    if (end > start && !s[end - 1].isWhitespace()) {
                        emit(styles)
                        walk(s.substring(start, end), styles + Style.STRIKE)
                        emit(styles + Style.STRIKE)
                        i = end + 2
                        continue
                    }
                }
                if (c == '*' || c == '_') {
                    val double = i + 1 < s.length && s[i + 1] == c
                    val marker = if (double) "$c$c" else "$c"
                    val start = i + marker.length
                    // An opener is followed by non-space; `_` inside a word (snake_case) is not one.
                    val opens = start < s.length && !s[start].isWhitespace() &&
                        !(c == '_' && i > 0 && s[i - 1].isLetterOrDigit())
                    val end = if (opens) closer(s, start, marker) else -1
                    if (end > start) {
                        emit(styles)
                        walk(s.substring(start, end), styles + if (double) Style.BOLD else Style.ITALIC)
                        emit(styles + if (double) Style.BOLD else Style.ITALIC)
                        i = end + marker.length
                        continue
                    }
                }
                buf.append(c)
                i++
            }
            emit(styles)
        }

        walk(text, emptySet())
        return out
    }

    /** The whole reply as plain text, as a screen reader or a copy would want it. */
    fun plain(text: String): String = parse(text).joinToString("\n") { piece ->
        when (piece) {
            is Piece.Code -> piece.code
            is Piece.Heading -> inline(piece.text).joinToString("") { it.text }
            is Piece.Bullet -> "${"  ".repeat(piece.indent)}${piece.marker} " + inline(piece.text).joinToString("") { it.text }
            is Piece.Quote -> inline(piece.text).joinToString("") { it.text }
            Piece.Rule -> ""
            is Piece.Paragraph -> inline(piece.text).joinToString("") { it.text }
        }
    }

    private const val PUNCT = "\\`*_[]()#+-.!>~|"

    /** `[label](url)` starting at [open]: label, url and the index after `)`. */
    private fun linkAt(s: String, open: Int): Triple<String, String, Int>? {
        var depth = 0
        var close = -1
        for (k in open until s.length) {
            when (s[k]) {
                '[' -> depth++
                ']' -> { depth--; if (depth == 0) { close = k; break } }
            }
        }
        if (close < 0 || close + 1 >= s.length || s[close + 1] != '(') return null
        val end = s.indexOf(')', close + 2)
        if (end < 0) return null
        val url = s.substring(close + 2, end).trim().substringBefore(' ')
        if (url.isEmpty()) return null
        return Triple(s.substring(open + 1, close), url, end + 1)
    }

    private fun closer(s: String, from: Int, marker: String): Int {
        var k = from
        while (true) {
            val at = s.indexOf(marker, k)
            if (at < 0) return -1
            val single = marker.length == 1
            // A single `*` must not be half of a `**`.
            val partOfDouble = single && ((at + 1 < s.length && s[at + 1] == marker[0]) || s[at - 1] == marker[0])
            if (at > from && !s[at - 1].isWhitespace() && !partOfDouble &&
                !(marker[0] == '_' && at + marker.length < s.length && s[at + marker.length].isLetterOrDigit())
            ) return at
            k = at + marker.length
        }
    }
}
