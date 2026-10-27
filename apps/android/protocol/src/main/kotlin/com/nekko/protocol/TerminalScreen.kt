package com.nekko.protocol

// A small terminal emulator for the phone's terminal screen (AN-31, a port of
// the iPhone's `TerminalScreen.swift`): enough of VT100/xterm for shells,
// prompts, `ls --color`, progress bars and simple full-screen programs,
// without a full xterm.
//
// Handled: printable text with wide (CJK, emoji) and combining characters;
// CR, LF, BS, TAB, BEL; SGR (bold, dim, italic, underline, inverse,
// strikethrough, 16 / 256 / 24-bit colours); cursor moves (CUU CUD CUF CUB
// CNL CPL CHA VPA CUP HVP), erase in line and display (EL, ED incl. 3),
// insert and delete of characters and lines (ICH DCH ECH IL DL), scroll up and
// down (SU SD), scroll regions (DECSTBM), index and reverse index, save and
// restore cursor (DECSC / DECRC, CSI s / u), the alternate screen (47, 1047,
// 1049), autowrap (7), cursor keys mode (1), cursor visibility (25) and
// bracketed paste (2004); OSC titles. Everything else is parsed and ignored.
//
// Not handled: replies to queries (DSR, DA: the desktop's own terminal
// answers those), character sets and line drawing, double width lines,
// mouse reporting, reflow of wrapped lines on resize, and the scroll-back of
// the alternate screen. The scroll-back keeps the newest `scrollbackLimit` lines.

/** A colour as the program asked for it; the app maps it to its palette. */
sealed interface TermColor {
    data object Default : TermColor
    /** 0–7 normal, 8–15 bright, 16–255 the xterm cube and greys. */
    data class Palette(val index: Int) : TermColor
    data class Rgb(val r: Int, val g: Int, val b: Int) : TermColor
}

data class TermStyle(
    val fg: TermColor = TermColor.Default,
    val bg: TermColor = TermColor.Default,
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    val strike: Boolean = false,
) {
    companion object {
        val PLAIN = TermStyle()
    }
}

data class TermCell(
    val text: String,
    val style: TermStyle,
    /** The right half of a wide character: drawn by the cell before it. */
    val continuation: Boolean = false,
) {
    companion object {
        val BLANK = TermCell(" ", TermStyle.PLAIN)
    }
}

/** One line as runs of equally styled text, trailing blanks dropped. */
data class TermLine(val runs: List<Run>) {
    data class Run(val text: String, val style: TermStyle)

    val text: String get() = runs.joinToString("") { it.text }
}

class TerminalScreen(cols: Int = 80, rows: Int = 24, val scrollbackLimit: Int = 1000) {
    var cols = maxOf(cols, 1)
        private set
    var rows = maxOf(rows, 1)
        private set
    var cursorX = 0
        private set
    var cursorY = 0
        private set
    /** The program asked for application cursor keys (arrows send `ESC O A`). */
    var appCursor = false
        private set
    /** The program asked for bracketed paste. */
    var bracketedPaste = false
        private set
    var cursorVisible = true
        private set
    var altScreen = false
        private set
    var title: String? = null
        private set

    private var lines: MutableList<MutableList<TermCell>> = blankScreen(this.cols, this.rows)
    private val scrollback = ArrayDeque<List<TermCell>>()
    private var savedMain: Triple<MutableList<MutableList<TermCell>>, Int, Int>? = null
    private var style = TermStyle()
    private var saved: Triple<Int, Int, TermStyle>? = null
    private var top = 0
    private var bottom = this.rows - 1
    private var autowrap = true
    private var wrapPending = false

    private enum class State { GROUND, ESCAPE, CSI, OSC, OSC_ESCAPE, STRING, STRING_ESCAPE, SKIP_ONE }
    private var state = State.GROUND
    private val params = StringBuilder()
    private val intermediates = StringBuilder()
    private val osc = StringBuilder()

    private var lastPut: Pair<Int, Int>? = null
    private var afterJoiner = false

    /** Back to an empty screen of the same size, as a fresh terminal. */
    fun reset() {
        lines = blankScreen(cols, rows)
        scrollback.clear()
        savedMain = null
        style = TermStyle()
        saved = null
        cursorX = 0
        cursorY = 0
        top = 0
        bottom = rows - 1
        autowrap = true
        wrapPending = false
        appCursor = false
        bracketedPaste = false
        cursorVisible = true
        altScreen = false
        state = State.GROUND
        params.clear()
        intermediates.clear()
        osc.clear()
    }

    // ---- feeding ----

    fun feed(text: String) {
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            step(cp)
            i += Character.charCount(cp)
        }
    }

    private fun step(v: Int) {
        when (state) {
            State.GROUND -> if (v == 0x1b) state = State.ESCAPE else if (v < 0x20 || v == 0x7f) control(v) else put(v)
            State.ESCAPE -> escape(v)
            State.CSI -> when {
                v == 0x1b -> state = State.ESCAPE
                v < 0x20 -> control(v)
                v in 0x30..0x3f -> if (params.length < 64) params.appendCodePoint(v)
                v in 0x20..0x2f -> if (intermediates.length < 4) intermediates.appendCodePoint(v)
                v in 0x40..0x7e -> {
                    state = State.GROUND
                    csi(v.toChar())
                }
                else -> state = State.GROUND
            }
            State.OSC -> if (v == 0x07) endOsc() else if (v == 0x1b) state = State.OSC_ESCAPE else if (osc.length < 512) osc.appendCodePoint(v)
            State.OSC_ESCAPE -> {
                // ESC \ ends it; anything else ends it too, then is read afresh.
                endOsc()
                if (v != 0x5c) step(v)
            }
            State.STRING -> if (v == 0x1b) state = State.STRING_ESCAPE else if (v == 0x07) state = State.GROUND
            State.STRING_ESCAPE -> state = if (v == 0x5c) State.GROUND else State.STRING
            State.SKIP_ONE -> state = State.GROUND
        }
    }

    private fun control(v: Int) {
        when (v) {
            0x08 -> {
                if (cursorX > 0) cursorX -= 1
                wrapPending = false
            }
            0x09 -> {
                cursorX = minOf((cursorX / 8 + 1) * 8, cols - 1)
                wrapPending = false
            }
            0x0a, 0x0b, 0x0c -> lineFeed()
            0x0d -> {
                cursorX = 0
                wrapPending = false
            }
            else -> Unit // BEL and the rest
        }
    }

    private fun escape(v: Int) {
        state = State.GROUND
        when (v.toChar()) {
            '[' -> {
                state = State.CSI
                params.clear()
                intermediates.clear()
            }
            ']' -> {
                state = State.OSC
                osc.clear()
            }
            'P', 'X', '^', '_' -> state = State.STRING
            '(', ')', '*', '+', '#', '%' -> state = State.SKIP_ONE
            '7' -> saveCursor()
            '8' -> restoreCursor()
            'D' -> lineFeed()
            'E' -> {
                cursorX = 0
                lineFeed()
            }
            'M' -> reverseIndex()
            'c' -> reset()
            else -> Unit
        }
    }

    private fun endOsc() {
        state = State.GROUND
        val s = osc.toString()
        val semi = s.indexOf(';')
        if (semi >= 0) {
            val kind = s.substring(0, semi)
            if (kind == "0" || kind == "2") title = s.substring(semi + 1)
        }
        osc.clear()
    }

    // ---- text ----

    private fun put(v: Int) {
        val at = lastPut
        if ((isJoining(v) || afterJoiner) && at != null && at.second < rows && at.first < cols) {
            val cell = lines[at.second][at.first]
            lines[at.second][at.first] = cell.copy(text = cell.text + String(Character.toChars(v)))
            afterJoiner = v == 0x200d
            return
        }
        afterJoiner = false
        val width = if (isWide(v)) 2 else 1
        if (wrapPending) {
            if (autowrap) {
                cursorX = 0
                lineFeed()
            }
            wrapPending = false
        }
        if (width == 2 && cursorX == cols - 1 && cols > 1) {
            if (autowrap) {
                lines[cursorY][cursorX] = blank()
                cursorX = 0
                lineFeed()
            } else {
                return
            }
        }
        lines[cursorY][cursorX] = TermCell(String(Character.toChars(v)), style)
        lastPut = cursorX to cursorY
        if (width == 2 && cursorX + 1 < cols) lines[cursorY][cursorX + 1] = TermCell("", style, continuation = true)
        cursorX += width
        if (cursorX >= cols) {
            cursorX = cols - 1
            wrapPending = autowrap
        }
    }

    private fun blank() = TermCell(" ", TermStyle(bg = style.bg))

    private fun blankLine(): MutableList<TermCell> = MutableList(cols) { blank() }

    // ---- moving and scrolling ----

    private fun lineFeed() {
        wrapPending = false
        if (cursorY == bottom) scrollUp(1) else if (cursorY < rows - 1) cursorY += 1
    }

    private fun reverseIndex() {
        wrapPending = false
        if (cursorY == top) scrollDown(1) else if (cursorY > 0) cursorY -= 1
    }

    private fun scrollUp(n: Int) {
        repeat(minOf(n, bottom - top + 1)) {
            val gone = lines.removeAt(top)
            if (top == 0 && !altScreen) {
                scrollback.addLast(gone)
                while (scrollback.size > scrollbackLimit) scrollback.removeFirst()
            }
            lines.add(bottom, blankLine())
        }
    }

    private fun scrollDown(n: Int) {
        repeat(minOf(n, bottom - top + 1)) {
            lines.removeAt(bottom)
            lines.add(top, blankLine())
        }
    }

    private fun moveTo(x: Int, y: Int) {
        cursorX = x.coerceIn(0, cols - 1)
        cursorY = y.coerceIn(0, rows - 1)
        wrapPending = false
    }

    private fun saveCursor() {
        saved = Triple(cursorX, cursorY, style)
    }

    private fun restoreCursor() {
        val s = saved ?: return moveTo(0, 0)
        style = s.third
        moveTo(s.first, s.second)
    }

    // ---- CSI ----

    private fun numbers(): List<Int> {
        val body = params.toString().dropWhile { it in "?<>=" }
        // `38:2:r:g:b` sub-parameters: the first number stands for the part here.
        return body.split(";").map { part -> part.split(":").first().toIntOrNull() ?: 0 }
    }

    private fun csi(final: Char) {
        val isPrivate = params.startsWith("?")
        val p = numbers()
        val n = maxOf(p.firstOrNull() ?: 1, 1)
        val n0 = p.firstOrNull() ?: 0
        if (intermediates.isNotEmpty()) return
        when (final) {
            'm' -> if (!isPrivate && !params.startsWith(">")) sgr()
            'A' -> moveTo(cursorX, cursorY - n)
            'B', 'e' -> moveTo(cursorX, cursorY + n)
            'C', 'a' -> moveTo(cursorX + n, cursorY)
            'D' -> moveTo(cursorX - n, cursorY)
            'E' -> moveTo(0, cursorY + n)
            'F' -> moveTo(0, cursorY - n)
            'G', '`' -> moveTo(n - 1, cursorY)
            'd' -> moveTo(cursorX, n - 1)
            'H', 'f' -> {
                val row = maxOf(p.firstOrNull() ?: 1, 1)
                val col = maxOf(if (p.size > 1) p[1] else 1, 1)
                moveTo(col - 1, row - 1)
            }
            'J' -> eraseDisplay(n0)
            'K' -> eraseLine(n0)
            'L' -> insertLines(n)
            'M' -> deleteLines(n)
            'P' -> deleteChars(n)
            '@' -> insertChars(n)
            'X' -> for (x in cursorX until minOf(cursorX + n, cols)) lines[cursorY][x] = blank()
            'S' -> scrollUp(n)
            'T' -> if (!isPrivate) scrollDown(n)
            'r' -> {
                val t = maxOf(p.firstOrNull() ?: 1, 1) - 1
                val b = minOf(if (p.size > 1 && p[1] > 0) p[1] else rows, rows) - 1
                if (t < b) {
                    top = t
                    bottom = b
                    moveTo(0, 0)
                }
            }
            's' -> if (!isPrivate) saveCursor()
            'u' -> if (!isPrivate) restoreCursor()
            'h', 'l' -> if (isPrivate) for (mode in p) privateMode(mode, on = final == 'h')
            else -> Unit // DSR, DA, window ops: the desktop's terminal answers queries
        }
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                eraseLine(0)
                for (y in cursorY + 1 until rows) lines[y] = blankLine()
            }
            1 -> {
                eraseLine(1)
                for (y in 0 until cursorY) lines[y] = blankLine()
            }
            2 -> for (y in 0 until rows) lines[y] = blankLine()
            3 -> {
                scrollback.clear()
                for (y in 0 until rows) lines[y] = blankLine()
            }
        }
    }

    private fun eraseLine(mode: Int) {
        val range = when (mode) {
            0 -> cursorX until cols
            1 -> 0 until minOf(cursorX + 1, cols)
            2 -> 0 until cols
            else -> return
        }
        for (x in range) lines[cursorY][x] = blank()
    }

    private fun insertLines(n: Int) {
        if (cursorY < top || cursorY > bottom) return
        repeat(minOf(n, bottom - cursorY + 1)) {
            lines.removeAt(bottom)
            lines.add(cursorY, blankLine())
        }
        cursorX = 0
    }

    private fun deleteLines(n: Int) {
        if (cursorY < top || cursorY > bottom) return
        repeat(minOf(n, bottom - cursorY + 1)) {
            lines.removeAt(cursorY)
            lines.add(bottom, blankLine())
        }
        cursorX = 0
    }

    private fun deleteChars(n: Int) {
        val line = lines[cursorY]
        val k = minOf(n, cols - cursorX)
        repeat(k) { line.removeAt(cursorX) }
        repeat(k) { line.add(blank()) }
    }

    private fun insertChars(n: Int) {
        val line = lines[cursorY]
        val k = minOf(n, cols - cursorX)
        repeat(k) { line.add(cursorX, blank()) }
        repeat(k) { line.removeAt(line.lastIndex) }
    }

    private fun privateMode(mode: Int, on: Boolean) {
        when (mode) {
            1 -> appCursor = on
            7 -> autowrap = on
            25 -> cursorVisible = on
            2004 -> bracketedPaste = on
            47, 1047, 1049 -> {
                val main = savedMain
                if (on && !altScreen) {
                    if (mode == 1049) saveCursor()
                    savedMain = Triple(lines, cursorX, cursorY)
                    altScreen = true
                    lines = MutableList(rows) { blankLine() }
                } else if (!on && altScreen && main != null) {
                    altScreen = false
                    lines = main.first
                    savedMain = null
                    if (mode == 1049) restoreCursor()
                }
                top = 0
                bottom = rows - 1
            }
        }
    }

    private fun sgr() {
        val raw = params.toString().split(";")
        val codes: List<List<Int>> = raw.map { part -> part.split(":").map { it.toIntOrNull() ?: 0 } }.ifEmpty { listOf(listOf(0)) }
        var i = 0
        fun byte(v: Int) = v.coerceIn(0, 255)
        fun extended(sub: List<Int>): TermColor? {
            // `38:5:n` / `38:2:r:g:b` in one parameter, or `38;5;n` / `38;2;r;g;b` across several.
            val rest: List<Int> = if (sub.size > 1) sub.drop(1) else codes.drop(i + 1).take(4).map { it.firstOrNull() ?: 0 }
            if (rest.firstOrNull() == 5 && rest.size >= 2) {
                if (sub.size <= 1) i += 2
                return TermColor.Palette(byte(rest[1]))
            }
            if (rest.firstOrNull() == 2) {
                // A colour-space id may sit before r:g:b in the colon form.
                val rgb = if (sub.size > 5) rest.drop(2) else rest.drop(1)
                if (rgb.size < 3) return null
                if (sub.size <= 1) i += 4
                return TermColor.Rgb(byte(rgb[0]), byte(rgb[1]), byte(rgb[2]))
            }
            return null
        }
        while (i < codes.size) {
            val sub = codes[i]
            when (val c = sub.firstOrNull() ?: 0) {
                0 -> style = TermStyle()
                1 -> style = style.copy(bold = true)
                2 -> style = style.copy(dim = true)
                3 -> style = style.copy(italic = true)
                4 -> style = style.copy(underline = sub.size < 2 || sub[1] != 0)
                7 -> style = style.copy(inverse = true)
                9 -> style = style.copy(strike = true)
                21 -> style = style.copy(underline = true)
                22 -> style = style.copy(bold = false, dim = false)
                23 -> style = style.copy(italic = false)
                24 -> style = style.copy(underline = false)
                27 -> style = style.copy(inverse = false)
                29 -> style = style.copy(strike = false)
                in 30..37 -> style = style.copy(fg = TermColor.Palette(c - 30))
                38 -> extended(sub)?.let { style = style.copy(fg = it) }
                39 -> style = style.copy(fg = TermColor.Default)
                in 40..47 -> style = style.copy(bg = TermColor.Palette(c - 40))
                48 -> extended(sub)?.let { style = style.copy(bg = it) }
                49 -> style = style.copy(bg = TermColor.Default)
                in 90..97 -> style = style.copy(fg = TermColor.Palette(c - 90 + 8))
                in 100..107 -> style = style.copy(bg = TermColor.Palette(c - 100 + 8))
            }
            i += 1
        }
    }

    // ---- size ----

    /** A new size: lines are cut or padded (no reflow); rows that no longer fit above the cursor go to the scroll-back. */
    fun resize(cols: Int, rows: Int) {
        val c = maxOf(cols, 1)
        val r = maxOf(rows, 1)
        if (c == this.cols && r == this.rows) return
        fun fit(line: List<TermCell>): MutableList<TermCell> {
            if (line.size >= c) {
                val l = line.take(c).toMutableList()
                // A wide character cut in half is dropped.
                if (line.size > c && line[c].continuation) l[c - 1] = TermCell.BLANK
                return l
            }
            return (line + List(c - line.size) { TermCell.BLANK }).toMutableList()
        }
        this.cols = c
        lines = lines.map { fit(it) }.toMutableList()
        val back = scrollback.map { fit(it) }
        scrollback.clear()
        scrollback.addAll(back)
        savedMain?.let { savedMain = it.copy(first = it.first.map { l -> fit(l) }.toMutableList()) }
        if (r < this.rows) {
            // Drop blank lines below the cursor first, then push the top into the scroll-back.
            var excess = this.rows - r
            while (excess > 0 && lines.size - 1 > cursorY && lines.last().all { it.text == " " || it.text.isEmpty() }) {
                lines.removeAt(lines.lastIndex)
                excess -= 1
            }
            while (lines.size > r) {
                val gone = lines.removeAt(0)
                if (!altScreen) scrollback.addLast(gone)
                cursorY -= 1
            }
            while (scrollback.size > scrollbackLimit) scrollback.removeFirst()
        } else if (r > this.rows) {
            repeat(r - this.rows) { lines.add(MutableList(c) { TermCell.BLANK }) }
        }
        this.rows = r
        top = 0
        bottom = r - 1
        cursorX = cursorX.coerceIn(0, c - 1)
        cursorY = cursorY.coerceIn(0, r - 1)
        wrapPending = false
        lastPut = null
    }

    // ---- reading ----

    /** The scroll-back then the screen, oldest first. With [cursor], the cursor's cell is drawn inverted while the program shows it. */
    fun rendered(cursor: Boolean = false): List<TermLine> {
        val back = if (altScreen) emptyList() else scrollback.map { line(it, null) }
        val screen = lines.mapIndexed { y, l -> line(l, if (cursor && cursorVisible && y == cursorY) cursorX else null) }
        return back + screen
    }

    /** The screen's text, one string per row, trailing blanks dropped (tests, accessibility). */
    val screenText: List<String> get() = lines.map { line(it, null).text }

    val scrollbackCount: Int get() = scrollback.size

    /** The style of a cell on the screen (tests). */
    fun style(x: Int, y: Int): TermStyle = lines[y][x].style

    companion object {
        private fun blankScreen(cols: Int, rows: Int): MutableList<MutableList<TermCell>> = MutableList(rows) { MutableList(cols) { TermCell.BLANK } }

        private fun isWide(v: Int): Boolean = v in 0x1100..0x115f || v in 0x2e80..0x303e || v in 0x3041..0x33ff || v in 0x3400..0x4dbf ||
            v in 0x4e00..0x9fff || v in 0xa000..0xa4cf || v in 0xac00..0xd7a3 || v in 0xf900..0xfaff || v in 0xfe30..0xfe4f ||
            v in 0xff00..0xff60 || v in 0xffe0..0xffe6 || v in 0x1f300..0x1f64f || v in 0x1f900..0x1f9ff || v in 0x1fa70..0x1faff ||
            v in 0x20000..0x3fffd

        /** Joins the character before it (accents, variation selectors, ZWJ sequences, skin tones). */
        private fun isJoining(v: Int): Boolean {
            if (v == 0x200d || v in 0xfe00..0xfe0f || v in 0x1f3fb..0x1f3ff || v in 0xe0020..0xe007f) return true
            return when (Character.getType(v).toByte()) {
                Character.NON_SPACING_MARK, Character.ENCLOSING_MARK, Character.COMBINING_SPACING_MARK -> true
                else -> false
            }
        }

        private fun line(cells: List<TermCell>, cursor: Int?): TermLine {
            val runs = mutableListOf<TermLine.Run>()
            val text = StringBuilder()
            var current: TermStyle? = null
            // Trailing blanks in the default style are dropped (the cursor's cell is kept).
            var end = cells.size
            while (end > 0 && cells[end - 1].text == " " && cells[end - 1].style == TermStyle.PLAIN && (cursor == null || cursor < end - 1)) end -= 1
            for (x in 0 until end) {
                val cell = cells[x]
                if (cell.continuation) continue
                var s = cell.style
                if (x == cursor) s = s.copy(inverse = !s.inverse)
                if (s != current) {
                    if (current != null && text.isNotEmpty()) runs += TermLine.Run(text.toString(), current)
                    text.clear()
                    current = s
                }
                text.append(cell.text.ifEmpty { " " })
            }
            if (current != null && text.isNotEmpty()) runs += TermLine.Run(text.toString(), current)
            return TermLine(runs)
        }
    }
}
