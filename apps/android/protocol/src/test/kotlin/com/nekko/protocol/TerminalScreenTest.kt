package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone's terminal screen, a small VT parser (AN-31): the iPhone's TerminalScreenTests, case for case. */
class TerminalScreenTest {
    private fun screen(cols: Int = 20, rows: Int = 5, text: String) = TerminalScreen(cols, rows).also { it.feed(text) }

    @Test fun `plain text, newlines and carriage returns`() {
        val s = screen(20, 4, "$ ls\r\nREADME.md\r\nsrc\r\n$ ")
        assertEquals(listOf("$ ls", "README.md", "src", "$"), s.screenText)
        assertEquals(listOf(2, 3), listOf(s.cursorX, s.cursorY))
        // CR overwrites: a progress line.
        assertEquals("100%", screen(20, 2, "10%\r50%\r100%").screenText[0])
    }

    @Test fun `backspace, tab and bell`() {
        assertEquals("aXc     Y", screen(20, 2, "abc\u0008\u0008X\u0007\tY").screenText[0])
    }

    @Test fun `SGR colours and attributes`() {
        val s = screen(30, 2, "\u001b[1;31mred\u001b[0m \u001b[38;5;208mo\u001b[38;2;1;2;3mr\u001b[4;7mu\u001b[22;24;27;39mn\u001b[92;104mb")
        assertEquals("red orunb", s.screenText[0])
        assertTrue(s.style(0, 0).bold)
        assertEquals(TermColor.Palette(1), s.style(0, 0).fg)
        assertEquals(TermStyle.PLAIN, s.style(3, 0))
        assertEquals(TermColor.Palette(208), s.style(4, 0).fg)
        assertEquals(TermColor.Rgb(1, 2, 3), s.style(5, 0).fg)
        assertTrue(s.style(6, 0).underline && s.style(6, 0).inverse)
        val n = s.style(7, 0)
        assertFalse(n.underline || n.inverse || n.bold)
        assertEquals(TermColor.Default, n.fg)
        assertEquals(TermColor.Palette(10), s.style(8, 0).fg)
        assertEquals(TermColor.Palette(12), s.style(8, 0).bg)
        // The colon form of 24-bit colour.
        assertEquals(TermColor.Rgb(9, 8, 7), screen(10, 1, "\u001b[38:2::9:8:7mx").style(0, 0).fg)
    }

    @Test fun `runs join equally styled text`() {
        val line = screen(20, 1, "\u001b[32mok\u001b[0m done").rendered()[0]
        assertEquals(listOf("ok", " done"), line.runs.map { it.text })
        assertEquals(TermColor.Palette(2), line.runs[0].style.fg)
    }

    @Test fun `erase line and display`() {
        val s = screen(10, 3, "aaaaa\r\nbbbbb\r\nccccc\u001b[2;3H\u001b[K")
        assertEquals(listOf("aaaaa", "bb", "ccccc"), s.screenText)
        s.feed("\u001b[1K")
        assertEquals("", s.screenText[1])
        s.feed("\u001b[J")
        assertEquals(listOf("aaaaa", "", ""), s.screenText)
        s.feed("\u001b[2J")
        assertEquals(listOf("", "", ""), s.screenText)
    }

    @Test fun `cursor moves and absolute positions`() {
        val s = screen(10, 4, "\u001b[3;4HX\u001b[AY\u001b[2DZ\u001b[GA\u001b[4dB")
        assertEquals(listOf("", "A  ZY", "   X", " B"), s.screenText)
    }

    @Test fun `scrolling keeps a scroll-back`() {
        val s = screen(10, 2, "1\r\n2\r\n3\r\n4")
        assertEquals(listOf("3", "4"), s.screenText)
        assertEquals(2, s.scrollbackCount)
        assertEquals(listOf("1", "2", "3", "4"), s.rendered().map { it.text })
        // ED 3 clears it.
        s.feed("\u001b[3J")
        assertEquals(0, s.scrollbackCount)
        // The limit holds.
        val many = TerminalScreen(5, 2, scrollbackLimit = 3)
        many.feed((1..10).joinToString("\r\n"))
        assertEquals(3, many.scrollbackCount)
    }

    @Test fun `autowrap at the last column`() {
        assertEquals(listOf("abcd", "ef", ""), screen(4, 3, "abcdef").screenText)
        // The wrap waits for the next character: a CR at the edge stays on the line.
        assertEquals(listOf("abcd", "x", ""), screen(4, 3, "abcd\r\nx").screenText)
        assertEquals(listOf("abcf", ""), screen(4, 2, "\u001b[?7labcdef").screenText)
    }

    @Test fun `wide and combining characters`() {
        val s = screen(6, 2, "日本é")
        // The accent joins the e in its cell (Swift compares é and e + U+0301 as equal; Kotlin compares the code points).
        assertEquals("日本e\u0301", s.screenText[0])
        assertEquals(5, s.cursorX)
        assertEquals("👍🏽!", screen(6, 1, "👍🏽!").screenText[0])
    }

    @Test fun `scroll region, insert and delete lines`() {
        val s = screen(5, 4, "a\r\nb\r\nc\r\nd\u001b[2;3r\u001b[3;1H\n")
        // Line feed at the region's bottom scrolls only the region.
        assertEquals(listOf("a", "c", "", "d"), s.screenText)
        s.feed("\u001b[2;1H\u001b[L")
        assertEquals(listOf("a", "", "c", "d"), s.screenText)
        s.feed("\u001b[M")
        assertEquals(listOf("a", "c", "", "d"), s.screenText)
        s.feed("\u001b[r\u001b[1;1H\u001bM")
        assertEquals("reverse index at the top scrolls down", listOf("", "a", "c", ""), s.screenText)
    }

    @Test fun `insert, delete and erase characters`() {
        val s = screen(8, 1, "abcdef\u001b[1;2H\u001b[2P")
        assertEquals("adef", s.screenText[0])
        s.feed("\u001b[2@")
        assertEquals("a  def", s.screenText[0])
        s.feed("\u001b[1;4H\u001b[2X")
        assertEquals("a    f", s.screenText[0])
    }

    @Test fun `the alternate screen comes back to the shell`() {
        val s = screen(10, 3, "$ vim\r\n\u001b[?1049h\u001b[H~\r\n~")
        assertTrue(s.altScreen)
        assertEquals(listOf("~", "~", ""), s.screenText)
        assertEquals("no scroll-back on the alternate screen", 3, s.rendered().size)
        s.feed("\u001b[?1049l")
        assertFalse(s.altScreen)
        assertEquals(listOf("$ vim", "", ""), s.screenText)
        assertEquals(listOf(0, 1), listOf(s.cursorX, s.cursorY))
    }

    @Test fun `modes the keys and paste follow`() {
        val s = screen(10, 2, "\u001b[?1h\u001b[?2004h\u001b[?25l")
        assertTrue(s.appCursor)
        assertTrue(s.bracketedPaste)
        assertFalse(s.cursorVisible)
        s.feed("\u001b[?1l\u001b[?2004l\u001b[?25h")
        assertFalse(s.appCursor || s.bracketedPaste)
    }

    @Test fun `OSC titles and unknown sequences are swallowed`() {
        val s = screen(20, 1, "\u001b]0;my title\u0007a\u001b]2;other\u001b\\b\u001b[6nc\u001b[>4;1md\u001b(Be\u001bP1\$r\u001b\\f\u001b[2 qg")
        assertEquals("abcdefg", s.screenText[0])
        assertEquals("other", s.title)
    }

    @Test fun `sequences split across chunks`() {
        val s = TerminalScreen(10, 1)
        for (part in listOf("\u001b", "[3", "1m", "x", "\u001b[", "0m", "y")) s.feed(part)
        assertEquals("xy", s.screenText[0])
        assertEquals(TermColor.Palette(1), s.style(0, 0).fg)
        assertEquals(TermStyle.PLAIN, s.style(1, 0))
    }

    @Test fun `resize cuts, pads and keeps the cursor line`() {
        val s = screen(10, 4, "one\r\ntwo\r\nthree\r\n$ ")
        s.resize(4, 2)
        assertEquals(listOf("thre", "$"), s.screenText)
        assertEquals(1, s.cursorY)
        assertEquals(listOf("one", "two", "thre", "$"), s.rendered().map { it.text })
        s.resize(8, 3)
        assertEquals(listOf("thre", "$", ""), s.screenText)
        assertEquals(listOf(8, 3), listOf(s.cols, s.rows))
    }

    @Test fun `the cursor is drawn inverted`() {
        val s = screen(10, 1, "ab")
        val line = s.rendered(cursor = true)[0]
        assertEquals(true, line.runs.last().style.inverse)
        assertEquals("ab ", line.text)
        s.feed("\u001b[?25l")
        assertEquals("ab", s.rendered(cursor = true)[0].text)
    }

    @Test fun `reset clears everything`() {
        val s = screen(10, 2, "\u001b[31mx\u001b[?1h")
        s.reset()
        assertEquals(listOf("", ""), s.screenText)
        assertFalse(s.appCursor)
        s.feed("y")
        assertEquals(TermStyle.PLAIN, s.style(0, 0))
    }
}
