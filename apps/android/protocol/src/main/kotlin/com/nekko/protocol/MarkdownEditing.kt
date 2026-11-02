package com.nekko.protocol

// The phone composer's formatting toolbar and typing rules (MD-6, the
// iPhone's MD-3 `MarkdownEditing`), as pure functions over the draft's
// Markdown source and its selection. Offsets are UTF-16, as Kotlin strings
// and Compose's TextRange count them (and as UITextView does on the iPhone).
// Mirrors the desktop's `composerFormatting.ts` (toggle inline marks and
// block prefixes, pressed when the selection already has the style), plus the
// phone's list continuation, indent and outdent, and table editing.

enum class MarkdownAction(val label: String) {
    BOLD("Bold"),
    ITALIC("Italic"),
    STRIKE("Strikethrough"),
    CODE("Inline code"),
    LINK("Link"),
    HEADING("Heading"),
    BULLET("Bulleted list"),
    ORDERED("Numbered list"),
    TASK("Task list"),
    INDENT("Indent"),
    OUTDENT("Outdent"),
    QUOTE("Quote"),
    FENCE("Code block"),
    TABLE("Table");

    /** Indent, outdent and table insert act; the rest toggle and can show as pressed. */
    val toggles: Boolean get() = this != INDENT && this != OUTDENT && this != TABLE
}

/** A draft after an edit: the new text and where the selection goes. */
data class MarkdownEdit(val text: String, val location: Int, val length: Int = 0)

/** A selection in the draft: [location] and [length] in UTF-16 units. */
data class MarkdownSelection(val location: Int, val length: Int = 0) {
    val end: Int get() = location + length
}

object MarkdownEditing {
    // ---- toolbar ----

    /** Whether the selection already has [action]'s style (the button shows pressed). */
    fun isActive(action: MarkdownAction, text: String, selection: MarkdownSelection): Boolean {
        val sel = clamp(selection, text)
        val start = sel.location
        val end = sel.end
        mark(action)?.let { return inlineSpan(text, start, end, it) != null }
        return when (action) {
            MarkdownAction.FENCE -> text.substring(0, start).endsWith("```\n") && text.substring(end).startsWith("\n```")
            MarkdownAction.LINK -> start > 0 && text[start - 1] == '[' && linkTail(text, end) != null
            MarkdownAction.INDENT, MarkdownAction.OUTDENT, MarkdownAction.TABLE -> false
            else -> {
                val (from, to) = block(text, start, end)
                text.substring(from, to).split("\n").all { matchesPrefix(action, it.trimStart(' ', '\t')) }
            }
        }
    }

    /** Apply a toolbar button to the selection (or the current line, for block styles). */
    fun apply(action: MarkdownAction, text: String, selection: MarkdownSelection): MarkdownEdit {
        val sel = clamp(selection, text)
        when (action) {
            MarkdownAction.INDENT -> return indent(text, sel, outdent = false)
            MarkdownAction.OUTDENT -> return indent(text, sel, outdent = true)
            MarkdownAction.TABLE -> return insertTable(text, sel)
            else -> {}
        }
        val start = sel.location
        val end = sel.end
        val active = isActive(action, text, sel)
        val mark = mark(action)
        if (mark != null) {
            val m = mark.length
            val span = if (active) inlineSpan(text, start, end, mark) else null
            if (span != null && start == end && start == span.second && span.second > span.first) {
                // The caret at the end of styled text: step out past the closing marks, so typing goes on plain.
                return MarkdownEdit(text, span.second + m)
            }
            if (span != null) {
                val out = text.removeRange(span.second, span.second + m).removeRange(span.first - m, span.first)
                return MarkdownEdit(out, start - m, end - start)
            }
            val out = text.replaceRange(start, end, mark + text.substring(start, end) + mark)
            return MarkdownEdit(out, start + m, end - start)
        }
        if (action == MarkdownAction.LINK) {
            val tail = if (active) linkTail(text, end) else null
            if (tail != null) {
                val out = text.removeRange(end, end + tail).removeRange(start - 1, start)
                return MarkdownEdit(out, start - 1, end - start)
            }
            // `[text](url)`: with nothing selected the text is picked to type over, else the url.
            val label = text.substring(start, end)
            val shown = label.ifEmpty { "text" }
            val out = text.replaceRange(start, end, "[$shown](url)")
            return if (label.isEmpty()) MarkdownEdit(out, start + 1, shown.length) else MarkdownEdit(out, start + shown.length + 3, 3)
        }
        if (action == MarkdownAction.FENCE) {
            if (active) {
                val out = text.removeRange(end, end + 4).removeRange(start - 4, start)
                return MarkdownEdit(out, start - 4, end - start)
            }
            // The fence goes on lines of its own.
            val before = if (start > 0 && text[start - 1] != '\n') "\n" else ""
            val after = if (end < text.length && text[end] != '\n') "\n" else ""
            val left = before + "```\n"
            val right = "\n```" + after
            val out = text.replaceRange(start, end, left + text.substring(start, end) + right)
            return MarkdownEdit(out, start + left.length, end - start)
        }
        // Block prefixes, line by line: strip any list/heading/quote prefix, then add this one (unless it was on).
        val (from, to) = block(text, start, end)
        val lines = text.substring(from, to).split("\n")
        val updated = lines.mapIndexed { i, line ->
            val indent = line.takeWhile { it == ' ' || it == '\t' }
            val body = stripPrefix(line.substring(indent.length))
            val prefix = if (active) "" else when (action) {
                MarkdownAction.HEADING -> "## "
                MarkdownAction.BULLET -> "- "
                MarkdownAction.ORDERED -> "${i + 1}. "
                MarkdownAction.TASK -> "- [ ] "
                else -> "> "
            }
            indent + prefix + body
        }
        val replacement = updated.joinToString("\n")
        val out = text.replaceRange(from, to, replacement)
        val firstDelta = updated[0].length - lines[0].length
        val totalDelta = replacement.length - (to - from)
        val newStart = maxOf(from, start + firstDelta)
        val newEnd = maxOf(newStart, end + totalDelta)
        return renumbered(MarkdownEdit(out, newStart, newEnd - newStart))
    }

    // ---- typing ----

    /**
     * Return on a list or quote line: continue it (next number, an empty task
     * box), or end the list when the item is empty. Null: an ordinary newline.
     */
    fun newline(text: String, selection: MarkdownSelection): MarkdownEdit? {
        val sel = clamp(selection, text)
        val (lineStart, lineEndWithBreak) = lineRange(text, sel.location)
        var line = text.substring(lineStart, lineEndWithBreak)
        if (line.endsWith("\n")) line = line.dropLast(1)
        val p = linePrefix(line) ?: return null
        val prefixEnd = lineStart + p.full.length
        // The caret before the marker: an ordinary newline.
        if (sel.location < prefixEnd) return null
        val lineEnd = lineStart + line.length
        val rest = text.substring(prefixEnd, lineEnd)
        if (rest.trim(' ', '\t').isEmpty() && sel.length == 0) {
            // An empty item ends the list: the marker goes, the line stays.
            return renumbered(MarkdownEdit(text.removeRange(lineStart, lineEnd), lineStart))
        }
        val insert = "\n" + p.indent + p.next
        val out = text.replaceRange(sel.location, sel.end, insert)
        return renumbered(MarkdownEdit(out, sel.location + insert.length))
    }

    /** Indent (or outdent) the selected lines by one list level: two spaces, or three under a numbered item. The numbers follow. */
    fun indent(text: String, selection: MarkdownSelection, outdent: Boolean): MarkdownEdit {
        val sel = clamp(selection, text)
        val start = sel.location
        val end = sel.end
        val (from, to) = block(text, start, end)
        val lines = text.substring(from, to).split("\n")
        var firstDelta = 0
        val updated = lines.mapIndexed { i, line ->
            val width = if (linePrefix(line)?.ordered == true) 3 else 2
            val out = if (outdent) {
                val spaces = line.takeWhile { it == ' ' }.length
                when {
                    spaces > 0 -> line.substring(minOf(spaces, width))
                    line.startsWith("\t") -> line.substring(1)
                    else -> line
                }
            } else {
                " ".repeat(width) + line
            }
            if (i == 0) firstDelta = out.length - line.length
            out
        }
        val replacement = updated.joinToString("\n")
        val out = text.replaceRange(from, to, replacement)
        val totalDelta = replacement.length - (to - from)
        val newStart = maxOf(from, start + firstDelta)
        return renumbered(MarkdownEdit(out, newStart, maxOf(0, end + totalDelta - newStart)))
    }

    /** Numbered items counted again from the top of each list (a nested list from 1), keeping the caret where it was in the text. */
    fun renumbered(edit: MarkdownEdit): MarkdownEdit {
        val lines = edit.text.split("\n")
        val out = mutableListOf<String>()
        // Per indentation: the next number of the numbered list open there.
        val open = mutableListOf<IntArray>() // [indent, next]
        var location = edit.location
        var end = edit.location + edit.length
        var offset = 0
        for (line in lines) {
            var newLine = line
            val indent = line.takeWhile { it == ' ' || it == '\t' }.length
            val p = linePrefix(line)
            if (p != null) {
                open.removeAll { it[0] > indent }
                val n = p.number
                if (p.ordered && n != null) {
                    val k = open.indexOfLast { it[0] == indent }
                    val number: Int
                    if (k >= 0) {
                        number = open[k][1]
                        open[k][1]++
                    } else {
                        // A top-level list keeps its first number; a nested one starts at 1.
                        number = if (indent == 0) n else 1
                        open += intArrayOf(indent, number + 1)
                    }
                    if (number != n) {
                        val digits = line.substring(indent).takeWhile { it.isDigit() }
                        val at = offset + indent
                        newLine = line.substring(0, indent) + number + line.substring(indent + digits.length)
                        val delta = number.toString().length - digits.length
                        if (location > at) location = maxOf(at, location + delta)
                        if (end > at) end = maxOf(at, end + delta)
                    }
                } else {
                    open.removeAll { it[0] >= indent }
                }
            } else if (line.trim(' ', '\t').isEmpty() || indent == 0) {
                // A blank line or an unindented paragraph closes every list.
                open.clear()
            }
            out += newLine
            offset += newLine.length + 1
        }
        return MarkdownEdit(out.joinToString("\n"), location, maxOf(0, end - location))
    }

    // ---- tables ----

    /** A 2×2 skeleton on lines of its own, the caret in the first header cell. */
    fun insertTable(text: String, selection: MarkdownSelection): MarkdownEdit {
        val sel = clamp(selection, text)
        val skeleton = "|  |  |\n| --- | --- |\n|  |  |"
        val before = if (sel.location > 0 && text[sel.location - 1] != '\n') "\n\n" else ""
        val after = if (sel.end < text.length && text[sel.end] != '\n') "\n" else ""
        val out = text.replaceRange(sel.location, sel.end, before + skeleton + after)
        return MarkdownEdit(out, sel.location + before.length + 2)
    }

    /** The lines of the table the caret is in (the header, its divider, its rows) as [start, end), or null. */
    fun tableLines(text: String, location: Int): IntRange? {
        val loc = location.coerceIn(0, text.length)
        fun isRow(r: Pair<Int, Int>) = '|' in text.substring(r.first, r.second)
        val here = lineRange(text, loc)
        if (!isRow(here)) return null
        var first = here
        var last = here
        while (first.first > 0) {
            val prev = lineRange(text, first.first - 1)
            if (!isRow(prev)) break
            first = prev
        }
        while (last.second < text.length) {
            val next = lineRange(text, last.second)
            if (!isRow(next)) break
            last = next
        }
        val lines = text.substring(first.first, last.second).split("\n").filter { it.isNotEmpty() }
        if (lines.size < 2) return null
        if (MarkdownParser.parse(lines.take(2).joinToString("\n") + "\n").firstOrNull() !is MarkdownBlock.Table) return null
        return first.first until last.second
    }

    /** A row below the caret's row (below the divider when the caret is in the header), caret in its first cell. */
    fun addRow(text: String, selection: MarkdownSelection): MarkdownEdit? {
        val sel = clamp(selection, text)
        val table = tableLines(text, sel.location) ?: return null
        val header = lineRange(text, table.first)
        val divider = lineRange(text, header.second)
        var row = lineRange(text, sel.location)
        if (row.first < divider.second) row = divider
        val columns = MarkdownParser.cells(text.substring(header.first, header.second).trim('\n')).size
        val newRow = "|" + "  |".repeat(columns)
        val rowText = text.substring(row.first, row.second)
        val insertAt = row.second
        val insert = if (rowText.endsWith("\n")) newRow + "\n" else "\n" + newRow
        val out = text.substring(0, insertAt) + insert + text.substring(insertAt)
        val lineStart = if (rowText.endsWith("\n")) insertAt else insertAt + 1
        return MarkdownEdit(out, lineStart + 2)
    }

    /** A column at the right of every row of the caret's table, caret in its header cell. */
    fun addColumn(text: String, selection: MarkdownSelection): MarkdownEdit? {
        val sel = clamp(selection, text)
        val table = tableLines(text, sel.location) ?: return null
        val lines = text.substring(table.first, table.last + 1).split("\n")
        var headerCell = 0
        var offset = table.first
        val trailing = Regex("""\s+$""")
        val updated = lines.mapIndexed { i, line ->
            if (line.isEmpty()) return@mapIndexed line
            val trimmed = trailing.replace(line, "")
            val closed = trimmed.endsWith("|")
            val out = trimmed + (if (closed) "" else " |") + (if (i == 1) " --- |" else "  |")
            if (i == 0) headerCell = offset + out.length - 2
            offset += line.length + 1
            out
        }
        val out = text.replaceRange(table.first, table.last + 1, updated.joinToString("\n"))
        return MarkdownEdit(out, headerCell)
    }

    /** Tab in a table: the caret to the next cell, then the next row's first (past the divider); from the last cell, a new row. Null outside a table. */
    fun nextCell(text: String, selection: MarkdownSelection): MarkdownEdit? {
        val sel = clamp(selection, text)
        val table = tableLines(text, sel.location) ?: return null
        val line = lineRange(text, sel.location)
        val pipes = pipePositions(text, line)
        val caret = sel.end
        val end = pipes.firstOrNull { it >= caret }
        if (end != null && end != pipes.last()) return MarkdownEdit(text, cellStart(text, end))
        // The next row, past the divider.
        var next = line.second
        val header = lineRange(text, table.first)
        if (line.first == header.first && next < table.last + 1) next = lineRange(text, next).second
        if (next < table.last + 1) {
            val row = lineRange(text, next)
            pipePositions(text, row).firstOrNull()?.let { return MarkdownEdit(text, cellStart(text, it)) }
        }
        return addRow(text, MarkdownSelection(caret))
    }

    private fun pipePositions(s: String, line: Pair<Int, Int>): List<Int> {
        val out = mutableListOf<Int>()
        var i = line.first
        while (i < line.second) {
            val c = s[i]
            if (c == '\\') {
                // A backslash escapes the next character.
                i += 2
                continue
            }
            if (c == '|') out += i
            i++
        }
        return out
    }

    /** Just inside a cell: after its pipe and one space. */
    private fun cellStart(s: String, pipe: Int) = if (pipe + 1 < s.length && s[pipe + 1] == ' ') pipe + 2 else pipe + 1

    // ---- helpers ----

    /** The selection kept inside the text: the toolbar can hold a selection a moment older than the text it is drawn with. */
    fun clamp(selection: MarkdownSelection, text: String): MarkdownSelection {
        val n = text.length
        val location = selection.location.coerceIn(0, n)
        return MarkdownSelection(location, selection.length.coerceIn(0, n - location))
    }

    /** The line holding [location], as [start, end) including its newline (NSString's `lineRange(for:)`). */
    fun lineRange(s: String, location: Int): Pair<Int, Int> {
        val loc = location.coerceIn(0, s.length)
        val start = if (loc == 0) 0 else s.lastIndexOf('\n', loc - 1) + 1
        val nl = s.indexOf('\n', loc)
        return start to (if (nl < 0) s.length else nl + 1)
    }

    private fun mark(action: MarkdownAction): String? = when (action) {
        MarkdownAction.BOLD -> "**"
        MarkdownAction.ITALIC -> "*"
        MarkdownAction.STRIKE -> "~~"
        MarkdownAction.CODE -> "`"
        else -> null
    }

    /** The lines the selection touches, without the last line's newline. */
    internal fun block(s: String, start: Int, end: Int): Pair<Int, Int> {
        val from = if (start == 0) 0 else lineRange(s, start).first
        val lastLine = lineRange(s, maxOf(start, end - if (end > start) 1 else 0))
        var to = lastLine.second
        if (to > from && to <= s.length && to > 0 && s[to - 1] == '\n') to--
        return from to maxOf(from, to)
    }

    /** The inline span (inside its marks) that holds the selection, if any. */
    internal fun inlineSpan(s: String, start: Int, end: Int, mark: String): Pair<Int, Int>? {
        val m = mark.length
        if (start == end && start >= m && end + m <= s.length && s.substring(start - m, start) == mark && s.substring(end, end + m) == mark) {
            return start to end
        }
        val escaped = Regex.escape(mark)
        for (match in Regex("$escaped[^\\n]+?$escaped").findAll(s)) {
            val from = match.range.first + m
            val to = match.range.last + 1 - m
            // A single * must not take a ** for its own marks.
            if (m == 1) {
                val c = mark[0]
                fun at(i: Int) = if (i in s.indices) s[i] else null
                if (at(from) == c || at(to - 1) == c || at(match.range.first - 1) == c) continue
            }
            if (start >= from && end <= to) return from to to
        }
        return null
    }

    private val LINK_TAIL = Regex("""^\]\([^\n)]*\)""")

    /** The length of a link's `](…)` right after [end], if there is one. */
    internal fun linkTail(s: String, end: Int): Int? = LINK_TAIL.find(s.substring(end))?.value?.length

    private val PREFIXES = mapOf(
        MarkdownAction.HEADING to Regex("""^#{1,6} """),
        MarkdownAction.BULLET to Regex("""^[-+*] (?!\[[ xX]\] )"""),
        MarkdownAction.ORDERED to Regex("""^\d+[.)] """),
        MarkdownAction.TASK to Regex("""^[-+*] \[[ xX]\] """),
        MarkdownAction.QUOTE to Regex("""^> """),
    )

    internal fun matchesPrefix(action: MarkdownAction, line: String): Boolean = PREFIXES[action]?.containsMatchIn(line) == true

    private val ANY_PREFIX = Regex("""^(?:#{1,6} |[-+*] (?:\[[ xX]\] )?|\d+[.)] |> )""")

    internal fun stripPrefix(body: String): String = ANY_PREFIX.find(body)?.let { body.substring(it.range.last + 1) } ?: body

    internal class LinePrefix(
        val indent: String,
        /** The indent and marker, as typed. */
        val full: String,
        /** What the next line starts with after the indent. */
        val next: String,
        val ordered: Boolean,
        val number: Int?,
    )

    private val TASK_MARK = Regex("""^[-+*] \[[ xX]\] ?""")
    private val BULLET_MARK = Regex("""^[-+*] """)
    private val NUMBER_MARK = Regex("""^\d{1,9}[.)] """)
    private val QUOTE_MARK = Regex("""^> ?""")

    /** A list or quote line's marker: `- `, `* `, `- [x] `, `3. `, `2) `, `> `. */
    internal fun linePrefix(line: String): LinePrefix? {
        val indent = line.takeWhile { it == ' ' || it == '\t' }
        val body = line.substring(indent.length)
        TASK_MARK.find(body)?.value?.let { return LinePrefix(indent, indent + it, it.take(1) + " [ ] ", false, null) }
        BULLET_MARK.find(body)?.value?.let { return LinePrefix(indent, indent + it, it, false, null) }
        NUMBER_MARK.find(body)?.value?.let { m ->
            val digits = m.takeWhile { it.isDigit() }
            val n = digits.toIntOrNull() ?: 1
            val delimiter = m.substring(digits.length, digits.length + 1)
            return LinePrefix(indent, indent + m, "${n + 1}$delimiter ", true, n)
        }
        QUOTE_MARK.find(body)?.value?.let { return LinePrefix(indent, indent + it, "> ", false, null) }
        return null
    }
}
