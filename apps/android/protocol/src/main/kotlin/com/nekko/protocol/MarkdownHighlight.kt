package com.nekko.protocol

/**
 * One styled run of the composer's Markdown source (MD-6, the iPhone's MD-3
 * `MarkdownSpan`): the text stays as typed, and these say how to draw it.
 * [start] and [length] are UTF-16, as Compose's AnnotatedString counts them.
 */
data class MarkdownSpan(val kind: Kind, val start: Int, val length: Int) {
    sealed interface Kind {
        data class Heading(val level: Int) : Kind
        /** Syntax drawn quieter: `**`, `#`, `` ` ``, a link's `](url)`. */
        data object Syntax : Kind
        /** A list or quote marker, tinted. */
        data object Marker : Kind
        data object Bold : Kind
        data object Italic : Kind
        data object Strike : Kind
        data object Code : Kind
        data object Link : Kind
        /** A fenced block's lines, fences included. */
        data object Fence : Kind
    }

    val end: Int get() = start + length
}

/** The composer's light live styling of Markdown source: bold looks bold with its `**` dimmed, headings are larger, list markers are tinted, code is monospaced. */
object MarkdownHighlight {
    /** Drafts longer than this are drawn plain (styling runs on every keystroke). */
    const val MAX_LENGTH = 20_000

    private fun re(p: String) = Regex(p, RegexOption.MULTILINE)
    private val HEADING = re("""^ {0,3}(#{1,6}) .*$""")
    private val LIST_MARKER = re("""^[ \t]*([-+*] \[[ xX]\]|[-+*]|\d{1,9}[.)])(?= )""")
    private val QUOTE_MARKER = re("""^[ \t]*(>)""")
    private val FENCE = re("""^[ \t]*(```|~~~)""")
    private val CODE_SPAN = re("""`[^`\n]+`""")
    private val BOLD = re("""\*\*[^*\n]+?\*\*|__[^_\n]+?__""")
    private val ITALIC = re("""(?<![*\w])\*(?!\*)[^*\n]+?(?<!\*)\*(?!\*)|(?<![_\w])_(?!_)[^_\n]+?(?<!_)_(?![_\w])""")
    private val STRIKE = re("""~~[^~\n]+?~~""")
    private val LINK = re("""\[([^\]\n]+)\](\([^)\n]*\))""")

    private fun overlaps(a: IntRange, s: Int, e: Int) = s <= a.last && e - 1 >= a.first && e > s

    fun spans(text: String): List<MarkdownSpan> {
        if (text.length > MAX_LENGTH) return emptyList()
        val out = mutableListOf<MarkdownSpan>()

        // Fenced blocks first: nothing inside them is Markdown.
        val fenced = mutableListOf<IntRange>()
        var open: Int? = null
        for (m in FENCE.findAll(text)) {
            val (lineStart, lineEnd) = MarkdownEditing.lineRange(text, m.range.first)
            val o = open
            if (o != null) {
                fenced += o until lineEnd
                open = null
            } else {
                open = lineStart
            }
        }
        open?.let { fenced += it until text.length }
        fenced.forEach { out += MarkdownSpan(MarkdownSpan.Kind.Fence, it.first, it.last + 1 - it.first) }
        fun free(s: Int, e: Int) = fenced.none { overlaps(it, s, e) }
        fun span(kind: MarkdownSpan.Kind, r: IntRange) = MarkdownSpan(kind, r.first, r.last + 1 - r.first)

        for (m in HEADING.findAll(text)) {
            if (!free(m.range.first, m.range.last + 1)) continue
            val hashes = m.groups[1]!!.range
            out += span(MarkdownSpan.Kind.Heading(hashes.last + 1 - hashes.first), m.range)
            out += span(MarkdownSpan.Kind.Syntax, hashes)
        }
        for (regex in listOf(LIST_MARKER, QUOTE_MARKER)) {
            for (m in regex.findAll(text)) if (free(m.range.first, m.range.last + 1)) out += span(MarkdownSpan.Kind.Marker, m.groups[1]!!.range)
        }

        val code = mutableListOf<IntRange>()
        for (m in CODE_SPAN.findAll(text)) {
            if (!free(m.range.first, m.range.last + 1)) continue
            code += m.range
            out += span(MarkdownSpan.Kind.Code, m.range)
            out += MarkdownSpan(MarkdownSpan.Kind.Syntax, m.range.first, 1)
            out += MarkdownSpan(MarkdownSpan.Kind.Syntax, m.range.last, 1)
        }
        fun plain(s: Int, e: Int) = free(s, e) && code.none { overlaps(it, s, e) }

        fun marked(regex: Regex, kind: MarkdownSpan.Kind, mark: Int) {
            for (m in regex.findAll(text)) {
                if (!plain(m.range.first, m.range.last + 1)) continue
                out += span(kind, m.range)
                out += MarkdownSpan(MarkdownSpan.Kind.Syntax, m.range.first, mark)
                out += MarkdownSpan(MarkdownSpan.Kind.Syntax, m.range.last + 1 - mark, mark)
            }
        }
        marked(BOLD, MarkdownSpan.Kind.Bold, 2)
        marked(ITALIC, MarkdownSpan.Kind.Italic, 1)
        marked(STRIKE, MarkdownSpan.Kind.Strike, 2)
        for (m in LINK.findAll(text)) {
            if (!plain(m.range.first, m.range.last + 1)) continue
            val label = m.groups[1]!!.range
            val target = m.groups[2]!!.range
            out += span(MarkdownSpan.Kind.Link, label)
            out += MarkdownSpan(MarkdownSpan.Kind.Syntax, m.range.first, 1)
            out += MarkdownSpan(MarkdownSpan.Kind.Syntax, label.last + 1, 1 + (target.last + 1 - target.first))
        }
        return out
    }
}
