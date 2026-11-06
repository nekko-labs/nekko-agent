package com.nekko.protocol

// The Markdown a chat contains, as a small block tree (MD-6, the iPhone's
// MD-1 `MarkdownParser` in `Markdown.swift`): paragraphs, headings, fenced
// code, quotes, rules, real nested lists and pipe tables. Inline styling
// (bold, links, code spans) stays inside the strings; `Markdown.inline` reads
// it when a block is drawn. Mirrors the desktop renderer
// (`apps/desktop/src/renderer/components/Markdown.tsx`): not CommonMark, but
// the constructs agent replies and phone messages use.

sealed interface MarkdownBlock {
    /** One or more lines; single newlines are kept as line breaks, as chat writes them. */
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    /** [closed] is false while a streaming reply has not written the closing fence yet. */
    data class Code(val language: String, val body: String, val closed: Boolean) : MarkdownBlock
    data class Quote(val blocks: List<MarkdownBlock>) : MarkdownBlock
    data class ListBlock(val list: MarkdownList) : MarkdownBlock
    data class Table(val table: MarkdownTable) : MarkdownBlock
    data object Rule : MarkdownBlock
}

data class MarkdownList(
    val ordered: Boolean,
    /** The first item's number (an ordered list may start anywhere). */
    val start: Int = 1,
    val items: List<MarkdownListItem>,
)

data class MarkdownListItem(
    /** Wrapped and continuation lines joined with `\n` (`\n\n` after a blank line), so they hang under the item, not the marker. */
    val text: String,
    val task: Task? = null,
    /** Lists nested under this item, in order (a bullet list under a numbered item, say). */
    val children: List<MarkdownList> = emptyList(),
) {
    enum class Task { OPEN, DONE }
}

data class MarkdownTable(
    val header: List<String>,
    val alignments: List<Alignment>,
    /** Body rows, each padded (or cut) to the header's column count. */
    val rows: List<List<String>>,
) {
    enum class Alignment { LEADING, CENTER, TRAILING }

    /** Large enough for an Expand button on the phone. */
    val isLarge: Boolean get() = header.size > EXPAND_COLUMNS || rows.size > EXPAND_ROWS

    /** The table as tidy Markdown (Copy as Markdown); pipes in cells are escaped. */
    val markdown: String
        get() {
            fun row(cells: List<String>) = "| " + cells.joinToString(" | ") { it.replace("|", "\\|") } + " |"
            val divider = "| " + alignments.joinToString(" | ") {
                when (it) {
                    Alignment.LEADING -> "---"
                    Alignment.CENTER -> ":---:"
                    Alignment.TRAILING -> "---:"
                }
            } + " |"
            return (listOf(row(header), divider) + rows.map(::row)).joinToString("\n")
        }

    /** Tab-separated plain text (Copy as text): pastes into a spreadsheet as cells. */
    val tabSeparated: String
        get() {
            fun clean(s: String) = MarkdownParser.plainText(s).replace('\t', ' ').replace('\n', ' ')
            return (listOf(header) + rows).joinToString("\n") { r -> r.joinToString("\t", transform = ::clean) }
        }

    /** What TalkBack reads for body row [index] (0-based): "Row 2 of 5: Name, Nekko; Status, done". */
    fun accessibilityRow(index: Int): String {
        val r = rows.getOrNull(index) ?: return ""
        val pairs = header.zip(r).joinToString("; ") { (h, v) -> "${MarkdownParser.plainText(h)}, ${MarkdownParser.plainText(v)}" }
        return "Row ${index + 1} of ${rows.size}: $pairs"
    }

    companion object {
        const val EXPAND_COLUMNS = 4
        const val EXPAND_ROWS = 12
    }
}

object MarkdownParser {
    // ---- whole text, cached by segment ----

    /**
     * The blocks of [text]. Finished segments (see [segments]) are parsed once
     * and cached, so a streaming reply re-parses only the segment being written.
     * Always equal to [parse].
     */
    fun blocks(text: String): List<MarkdownBlock> = segments(text).flatMap(::cachedParse)

    /**
     * [text] split where no block carries across: at a blank line (outside a
     * fence) followed by an unindented line. An indented line after a blank one
     * can still belong to the list above, so it stays in the same segment.
     */
    fun segments(text: String): List<String> {
        val out = mutableListOf<String>()
        var current = mutableListOf<String>()
        val blanks = mutableListOf<String>()
        var fence: MDFence? = null
        for (line in text.split("\n")) {
            val l = MDLine(line)
            if (fence == null && l.isBlank) {
                blanks += line
                continue
            }
            if (blanks.isNotEmpty()) {
                if (fence == null && l.indent == 0 && current.isNotEmpty()) {
                    out += current.joinToString("\n")
                    current = mutableListOf()
                } else {
                    current += blanks
                }
                blanks.clear()
            }
            current += line
            val f = fence
            if (f != null) {
                if (f.closes(l)) fence = null
            } else {
                fence = MDFence.of(l)
            }
        }
        if (current.isNotEmpty()) out += current.joinToString("\n")
        return out
    }

    private const val CACHE_SIZE = 2_000
    private val cache = object : LinkedHashMap<String, List<MarkdownBlock>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<MarkdownBlock>>?) = size > CACHE_SIZE
    }

    private fun cachedParse(segment: String): List<MarkdownBlock> {
        synchronized(cache) { cache[segment]?.let { return it } }
        val blocks = parse(segment)
        synchronized(cache) { cache[segment] = blocks }
        return blocks
    }

    // ---- parsing ----

    /** Parse [text] in one pass, uncached. */
    fun parse(text: String): List<MarkdownBlock> {
        val lines = text.replace("\r\n", "\n").split("\n").map(::MDLine)
        return parseBlocks(lines, Cursor())
    }

    private class Cursor(var i: Int = 0)

    private fun parseBlocks(lines: List<MDLine>, c: Cursor): List<MarkdownBlock> {
        val out = mutableListOf<MarkdownBlock>()
        while (c.i < lines.size) {
            val l = lines[c.i]
            if (l.isBlank) {
                c.i++
                continue
            }
            val f = MDFence.of(l)
            if (f != null) {
                val body = mutableListOf<String>()
                var closed = false
                c.i++
                while (c.i < lines.size) {
                    if (f.closes(lines[c.i])) {
                        closed = true
                        c.i++
                        break
                    }
                    body += f.strip(lines[c.i])
                    c.i++
                }
                out += MarkdownBlock.Code(f.info, body.joinToString("\n"), closed)
                continue
            }
            heading(l)?.let {
                out += it
                c.i++
                continue
            }
            if (isRule(l)) {
                out += MarkdownBlock.Rule
                c.i++
                continue
            }
            if (l.content.startsWith(">")) {
                val inner = mutableListOf<MDLine>()
                while (c.i < lines.size && lines[c.i].content.startsWith(">")) {
                    var rest = lines[c.i].content.substring(1)
                    if (rest.startsWith(" ")) rest = rest.substring(1)
                    inner += MDLine(rest)
                    c.i++
                }
                out += MarkdownBlock.Quote(parseBlocks(inner, Cursor()))
                continue
            }
            table(lines, c)?.let {
                out += MarkdownBlock.Table(it)
                continue
            }
            if (listItem(l) != null) {
                out += list(lines, c).map(MarkdownBlock::ListBlock)
                continue
            }
            val para = mutableListOf<String>()
            while (c.i < lines.size && !lines[c.i].isBlank && (para.isEmpty() || !startsBlock(lines, c.i, interrupting = true))) {
                para += lines[c.i].raw
                c.i++
            }
            out += MarkdownBlock.Paragraph(para.joinToString("\n"))
        }
        return out
    }

    /**
     * True for a line that starts a block of its own, so a paragraph or list item stops.
     * Inside a paragraph only a numbered item starting at 1 begins a list, as in
     * CommonMark, so a sentence that wraps onto "2026. A year." stays a sentence.
     */
    private fun startsBlock(lines: List<MDLine>, i: Int, interrupting: Boolean = false): Boolean {
        val l = lines[i]
        listItem(l)?.let { return !interrupting || !it.ordered || it.number == 1 }
        return l.isBlank || MDFence.of(l) != null || heading(l) != null || isRule(l) || l.content.startsWith(">") || isTableStart(lines, i)
    }

    private val CLOSING_HASHES = Regex("""\s+#+$""")

    private fun heading(l: MDLine): MarkdownBlock.Heading? {
        val c = l.content
        val hashes = c.takeWhile { it == '#' }.length
        if (hashes !in 1..6) return null
        val rest = c.substring(hashes)
        if (rest.isNotEmpty() && rest[0] != ' ' && rest[0] != '\t') return null
        var text = rest.trim(' ', '\t')
        // A closing run of #s is decoration (`## Title ##`).
        val m = CLOSING_HASHES.find(text)
        if (m != null) text = text.substring(0, m.range.first) else if (text.all { it == '#' }) text = ""
        return MarkdownBlock.Heading(hashes, text)
    }

    private fun isRule(l: MDLine): Boolean {
        val s = l.content.filter { it != ' ' && it != '\t' }
        if (s.length < 3) return false
        val c = s[0]
        return c in "-*_" && s.all { it == c }
    }

    // ---- lists ----

    private data class Item(val indent: Int, val ordered: Boolean, val number: Int, var text: String)

    /** A list item's marker and text: `- x`, `* x`, `+ x`, `1. x`, `1) x`. */
    private fun listItem(l: MDLine): Item? {
        val c = l.content
        val first = c.firstOrNull() ?: return null
        if (first in "-*+") {
            val rest = c.substring(1)
            if (rest.isEmpty()) return null
            if (rest[0] != ' ' && rest[0] != '\t') return null
            return Item(l.indent, false, 0, rest.trimStart(' ', '\t'))
        }
        val digits = c.takeWhile { it in '0'..'9' }
        if (digits.length !in 1..9) return null
        val rest = c.substring(digits.length)
        val d = rest.firstOrNull() ?: return null
        if (d != '.' && d != ')') return null
        val after = rest.substring(1)
        // "1." alone is not an item; a bare "2026." is a sentence.
        if (after.isEmpty() || (after[0] != ' ' && after[0] != '\t')) return null
        return Item(l.indent, true, digits.toIntOrNull() ?: 1, after.trimStart(' ', '\t'))
    }

    private fun list(lines: List<MDLine>, c: Cursor): List<MarkdownList> {
        val flat = mutableListOf<Item>()
        var afterBlank = false
        while (c.i < lines.size) {
            val l = lines[c.i]
            if (l.isBlank) {
                // A blank line ends the list unless an indented line follows (a nested item, a second paragraph).
                var k = c.i
                while (k < lines.size && lines[k].isBlank) k++
                if (k >= lines.size || lines[k].indent == 0 || MDFence.of(lines[k]) != null) break
                afterBlank = true
                c.i = k
                continue
            }
            val item = listItem(l)
            if (item != null) {
                if (isRule(l)) break
                flat += item
            } else if (startsBlock(lines, c.i)) {
                break
            } else {
                // A wrapped or continued line hangs under the item that owns it: the
                // nearest one above it that is less indented, or (lazily) the last one.
                val owner = flat.indexOfLast { it.indent < l.indent }.takeIf { it >= 0 } ?: flat.lastIndex
                if (owner >= 0) flat[owner].text += (if (afterBlank) "\n\n" else "\n") + l.content
            }
            afterBlank = false
            c.i++
        }
        return nest(flat)
    }

    /**
     * Fold a flat run of items into lists: items more indented than the run's
     * first become children of the item above them. A change between bullets
     * and numbers at the same level starts a new list.
     */
    private fun nest(flat: List<Item>): List<MarkdownList> {
        val base = flat.firstOrNull()?.indent ?: return emptyList()
        val lists = mutableListOf<MarkdownList>()
        var i = 0
        while (i < flat.size) {
            var end = i + 1
            while (end < flat.size && flat[end].indent > base) end++
            val it = flat[i]
            var text = it.text
            var task: MarkdownListItem.Task? = null
            if (text.startsWith("[ ]") || text.startsWith("[x]") || text.startsWith("[X]")) {
                val after = text.substring(3)
                if (after.isEmpty() || after[0] == ' ' || after[0] == '\n') {
                    task = if (text.startsWith("[ ]")) MarkdownListItem.Task.OPEN else MarkdownListItem.Task.DONE
                    text = after.trimStart(' ')
                }
            }
            val item = MarkdownListItem(text, task, nest(flat.subList(i + 1, end)))
            val last = lists.lastOrNull()
            if (last != null && last.ordered == it.ordered) {
                lists[lists.lastIndex] = last.copy(items = last.items + item)
            } else {
                lists += MarkdownList(it.ordered, if (it.ordered) it.number else 1, listOf(item))
            }
            i = end
        }
        return lists
    }

    /** The marker drawn for an item: •, ◦, ▪ for bullets and 1., a., i. for numbers, by depth (0 at the top), cycling after three levels. */
    fun marker(ordered: Boolean, depth: Int, number: Int): String {
        val level = depth % 3
        if (!ordered) return listOf("•", "◦", "▪")[level]
        return when (level) {
            0 -> "$number."
            1 -> letters(number) + "."
            else -> roman(number) + "."
        }
    }

    internal fun letters(n: Int): String {
        if (n <= 0) return "$n"
        var k = n
        val sb = StringBuilder()
        while (k > 0) {
            k--
            sb.insert(0, ('a' + k % 26))
            k /= 26
        }
        return sb.toString()
    }

    internal fun roman(n: Int): String {
        if (n <= 0 || n >= 4000) return "$n"
        val table = listOf(1000 to "m", 900 to "cm", 500 to "d", 400 to "cd", 100 to "c", 90 to "xc", 50 to "l", 40 to "xl", 10 to "x", 9 to "ix", 5 to "v", 4 to "iv", 1 to "i")
        var k = n
        val sb = StringBuilder()
        for ((v, r) in table) while (k >= v) {
            sb.append(r)
            k -= v
        }
        return sb.toString()
    }

    // ---- tables ----

    /** A header row with a pipe, then a `|---|:---:|` divider with as many cells. */
    private fun isTableStart(lines: List<MDLine>, i: Int): Boolean {
        if (i + 1 >= lines.size || '|' !in lines[i].content || listItem(lines[i]) != null) return false
        return isDivider(lines[i + 1], cells(lines[i].content).size)
    }

    private fun isDivider(l: MDLine, columns: Int): Boolean {
        val c = l.content.trim(' ', '\t')
        if ('-' !in c || '|' !in c || !c.all { it in "|:- \t" }) return false
        val d = cells(c)
        if (d.size != columns) return false
        return d.all { cell ->
            val t = cell.trim(' ', '\t')
            t.isNotEmpty() && '-' in t && t.drop(1).dropLast(1).all { it == '-' }
        }
    }

    private fun table(lines: List<MDLine>, c: Cursor): MarkdownTable? {
        if (!isTableStart(lines, c.i)) return null
        val header = cells(lines[c.i].content)
        val divider = cells(lines[c.i + 1].content)
        val alignments = header.indices.map { k ->
            val t = divider.getOrNull(k)?.trim(' ', '\t') ?: return@map MarkdownTable.Alignment.LEADING
            when {
                t.startsWith(":") && t.endsWith(":") && t.length > 1 -> MarkdownTable.Alignment.CENTER
                t.endsWith(":") -> MarkdownTable.Alignment.TRAILING
                else -> MarkdownTable.Alignment.LEADING
            }
        }
        c.i += 2
        val rows = mutableListOf<List<String>>()
        while (c.i < lines.size && !lines[c.i].isBlank && '|' in lines[c.i].content && MDFence.of(lines[c.i]) == null) {
            val r = cells(lines[c.i].content)
            rows += (r + List(maxOf(0, header.size - r.size)) { "" }).take(header.size)
            c.i++
        }
        return MarkdownTable(header, alignments, rows)
    }

    /** A row's cells: outer pipes dropped, split on unescaped pipes, `\|` kept as a literal pipe. */
    fun cells(row: String): List<String> {
        var s = row.trim(' ', '\t')
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
        val out = mutableListOf<String>()
        val cell = StringBuilder()
        var escaped = false
        for (ch in s) {
            when {
                escaped -> {
                    if (ch == '|') cell.append('|') else cell.append('\\').append(ch)
                    escaped = false
                }
                ch == '\\' -> escaped = true
                ch == '|' -> {
                    out += cell.toString().trim(' ', '\t')
                    cell.clear()
                }
                else -> cell.append(ch)
            }
        }
        if (escaped) cell.append('\\')
        out += cell.toString().trim(' ', '\t')
        return out
    }

    // ---- plain text ----

    private val LINK = Regex("""!?\[([^\]]*)\]\([^)]*\)""")

    /** Inline Markdown reduced to what it says: `[t](u)` → t, and `**`, `__`, `~~` and backticks dropped. */
    fun plainText(s: String): String {
        var out = LINK.replace(s) { it.groupValues[1] }
        for (mark in listOf("**", "__", "~~", "`")) out = out.replace(mark, "")
        return out
    }
}

/** One source line, with its indentation measured (a tab counts as four spaces). */
internal class MDLine(val raw: String) {
    val indent: Int
    val content: String

    init {
        var n = 0
        var idx = 0
        while (idx < raw.length && (raw[idx] == ' ' || raw[idx] == '\t')) {
            n += if (raw[idx] == '\t') 4 else 1
            idx++
        }
        indent = n
        content = raw.substring(idx).trimEnd(' ', '\t', '\r')
    }

    val isBlank: Boolean get() = content.isEmpty()
}

/** An opening ``` or ~~~ fence: its character, length, info string and indentation. */
internal class MDFence private constructor(val char: Char, val length: Int, val info: String, val indent: Int) {
    fun closes(l: MDLine): Boolean {
        val run = l.content.takeWhile { it == char }.length
        return run >= length && run == l.content.length
    }

    /** A body line with the fence's own indentation taken off (code inside a list item). */
    fun strip(l: MDLine): String {
        var s = l.raw
        var n = 0
        while (n < indent && s.startsWith(" ")) {
            s = s.substring(1)
            n++
        }
        return s
    }

    companion object {
        fun of(l: MDLine): MDFence? {
            val c = l.content.firstOrNull() ?: return null
            if (c != '`' && c != '~') return null
            val run = l.content.takeWhile { it == c }.length
            if (run < 3) return null
            val info = l.content.substring(run).trim(' ', '\t')
            // A backtick fence's info string can't hold a backtick (that's inline code).
            if (c == '`' && '`' in info) return null
            return MDFence(c, run, info.split(' ').firstOrNull().orEmpty(), l.indent)
        }
    }
}
