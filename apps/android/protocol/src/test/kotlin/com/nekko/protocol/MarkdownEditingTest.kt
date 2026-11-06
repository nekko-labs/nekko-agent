package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MD-6: the composer toolbar's edit functions, typing rules and live styling, with the iPhone's MarkdownEditingTests cases. */
class MarkdownEditingTest {
    /** [marked] with `‸` marking the caret (or two `‸` marking a selection). */
    private fun draft(marked: String): Pair<String, MarkdownSelection> {
        val first = marked.indexOf('‸')
        val rest = marked.removeRange(first, first + 1)
        val second = rest.indexOf('‸', first)
        if (second < 0) return rest to MarkdownSelection(first)
        return rest.removeRange(second, second + 1) to MarkdownSelection(first, second - first)
    }

    /** The edit's text with its selection marked the same way. */
    private fun shown(e: MarkdownEdit): String {
        if (e.length == 0) return e.text.substring(0, e.location) + "‸" + e.text.substring(e.location)
        val end = e.location + e.length
        return e.text.substring(0, e.location) + "‸" + e.text.substring(e.location, end) + "‸" + e.text.substring(end)
    }

    private fun apply(action: MarkdownAction, marked: String): String {
        val (t, sel) = draft(marked)
        return shown(MarkdownEditing.apply(action, t, sel))
    }

    private fun active(action: MarkdownAction, marked: String): Boolean {
        val (t, sel) = draft(marked)
        return MarkdownEditing.isActive(action, t, sel)
    }

    @Test fun `toggles each inline style`() {
        assertEquals("say **‸hello‸** now", apply(MarkdownAction.BOLD, "say ‸hello‸ now"))
        assertEquals("say ‸hello‸ now", apply(MarkdownAction.BOLD, "say **‸hello‸** now"))
        assertEquals("*‸word‸*", apply(MarkdownAction.ITALIC, "‸word‸"))
        assertEquals("‸word‸", apply(MarkdownAction.ITALIC, "*‸word‸*"))
        assertEquals("~~‸old‸~~", apply(MarkdownAction.STRIKE, "‸old‸"))
        assertEquals("run `‸ls‸`", apply(MarkdownAction.CODE, "run ‸ls‸"))
        assertEquals("run l‸s", apply(MarkdownAction.CODE, "run `l‸s`"))
        // Nothing selected: the marks go in with the caret between them, and come out again.
        assertEquals("a **‸**", apply(MarkdownAction.BOLD, "a ‸"))
        assertEquals("a ‸", apply(MarkdownAction.BOLD, "a **‸**"))
        // At the end of bold text the button steps out of it, so typing goes on plain.
        assertEquals("a **b**‸ c", apply(MarkdownAction.BOLD, "a **b‸** c"))
        assertEquals("*it*‸", apply(MarkdownAction.ITALIC, "*it‸*"))
    }

    @Test fun `pressed state follows the selection`() {
        assertTrue(active(MarkdownAction.BOLD, "**a ‸b‸ c**"))
        assertFalse(active(MarkdownAction.BOLD, "a ‸b‸ c"))
        // A single * is not mistaken for the inside of a **.
        assertFalse(active(MarkdownAction.ITALIC, "**‸bold‸**"))
        assertTrue(active(MarkdownAction.ITALIC, "*‸it‸*"))
        assertTrue(active(MarkdownAction.LINK, "[‸docs‸](https://x.dev)"))
        assertTrue(active(MarkdownAction.BULLET, "- a\n- ‸b"))
        assertFalse(active(MarkdownAction.BULLET, "- [ ] ‸task"))
        assertTrue(active(MarkdownAction.TASK, "- [ ] ‸task"))
        assertTrue(active(MarkdownAction.FENCE, "```\n‸code‸\n```"))
    }

    @Test fun links() {
        assertEquals("see [docs](‸url‸) here", apply(MarkdownAction.LINK, "see ‸docs‸ here"))
        assertEquals("see [‸text‸](url)", apply(MarkdownAction.LINK, "see ‸"))
        assertEquals("see ‸docs‸ here", apply(MarkdownAction.LINK, "see [‸docs‸](https://x.dev) here"))
    }

    @Test fun `block toggles on several lines`() {
        assertEquals("- ‸one\n- two‸", apply(MarkdownAction.BULLET, "‸one\ntwo‸"))
        assertEquals("‸one\ntwo‸", apply(MarkdownAction.BULLET, "- ‸one\n- two‸"))
        assertEquals("1. ‸one\n2. two\n3. three‸", apply(MarkdownAction.ORDERED, "‸one\ntwo\nthree‸"))
        assertEquals("- [ ] ‸one", apply(MarkdownAction.TASK, "- ‸one"))
        assertEquals("a\n> ‸b‸\nc", apply(MarkdownAction.QUOTE, "a\n‸b‸\nc"))
        assertEquals("## ‸Title", apply(MarkdownAction.HEADING, "‸Title"))
        assertEquals("‸Title", apply(MarkdownAction.HEADING, "## ‸Title"))
        // Switching style replaces the old marker and keeps the indent.
        assertEquals("  - ‸one", apply(MarkdownAction.BULLET, "  1. ‸one"))
    }

    @Test fun `code block goes on lines of its own`() {
        assertEquals("```\n‸let x = 1‸\n```", apply(MarkdownAction.FENCE, "‸let x = 1‸"))
        assertEquals("say \n```\n‸x‸\n```\n now", apply(MarkdownAction.FENCE, "say ‸x‸ now"))
        assertEquals("‸x‸", apply(MarkdownAction.FENCE, "```\n‸x‸\n```"))
    }

    private fun ret(marked: String): String? {
        val (t, sel) = draft(marked)
        return MarkdownEditing.newline(t, sel)?.let(::shown)
    }

    @Test fun `return continues a list`() {
        assertEquals("- one\n- ‸", ret("- one‸"))
        assertEquals("  * nested\n  * ‸", ret("  * nested‸"))
        assertEquals("1. one\n2. ‸", ret("1. one‸"))
        assertEquals("9) nine\n10) ‸", ret("9) nine‸"))
        assertEquals("- [x] done\n- [ ] ‸", ret("- [x] done‸"))
        assertEquals("> quote\n> ‸", ret("> quote‸"))
        // In the middle of an item the rest moves to the new item.
        assertEquals("- one\n- ‸ two", ret("- one‸ two"))
        // Inserting in the middle of a numbered list renumbers what follows.
        assertEquals("1. a\n2. ‸\n3. b\n4. c", ret("1. a‸\n2. b\n3. c"))
        // Plain text: an ordinary newline.
        assertNull(ret("plain‸"))
        assertNull(ret("‸- before the marker"))
    }

    @Test fun `return on an empty item ends the list`() {
        assertEquals("- one\n‸", ret("- one\n- ‸"))
        assertEquals("a top-level list after the gap keeps its number", "1. a\n‸\n3. c", ret("1. a\n2. ‸\n3. c"))
    }

    @Test fun `indent and outdent`() {
        assertEquals("- a\n  - ‸b", apply(MarkdownAction.INDENT, "- a\n- ‸b"))
        assertEquals("- a\n- ‸b", apply(MarkdownAction.OUTDENT, "- a\n  - ‸b"))
        // Under a numbered item the step is three spaces, and the nested list counts from 1.
        assertEquals("1. a\n   1. ‸b\n2. c", apply(MarkdownAction.INDENT, "1. a\n2. ‸b\n3. c"))
        assertEquals("1. a\n2. ‸b\n3. c", apply(MarkdownAction.OUTDENT, "1. a\n   1. ‸b\n2. c"))
        // Several lines at once.
        assertEquals("  ‸- a\n  - b‸", apply(MarkdownAction.INDENT, "‸- a\n- b‸"))
        // Outdent at the left edge does nothing.
        assertEquals("- ‸a", apply(MarkdownAction.OUTDENT, "- ‸a"))
    }

    @Test fun `renumber keeps a top-level start`() {
        assertEquals("3. a\n4. b\n\npara\n5. c", MarkdownEditing.renumbered(MarkdownEdit("3. a\n7. b\n\npara\n5. c", 0)).text)
    }

    @Test fun `inserts a table skeleton`() {
        assertEquals("| ‸ |  |\n| --- | --- |\n|  |  |", apply(MarkdownAction.TABLE, "‸"))
        assertEquals("Intro\n\n| ‸ |  |\n| --- | --- |\n|  |  |", apply(MarkdownAction.TABLE, "Intro‸"))
    }

    @Test fun `adds rows and columns inside a table`() {
        val (t, sel) = draft("| A | B |\n| --- | --- |\n| 1 | 2‸ |\nafter")
        assertNotNull(MarkdownEditing.tableLines(t, sel.location))
        assertEquals("| A | B |\n| --- | --- |\n| 1 | 2 |\n| ‸ |  |\nafter", MarkdownEditing.addRow(t, sel)?.let(::shown))
        assertEquals("| A | B | ‸ |\n| --- | --- | --- |\n| 1 | 2 |  |\nafter", MarkdownEditing.addColumn(t, sel)?.let(::shown))
        // From the header, a row goes under the divider.
        val (h, hs) = draft("| A‸ | B |\n| --- | --- |")
        assertEquals("| A | B |\n| --- | --- |\n| ‸ |  |", MarkdownEditing.addRow(h, hs)?.let(::shown))
        // Outside a table there is nothing to add to.
        assertNull(MarkdownEditing.addRow("plain", MarkdownSelection(2)))
        assertNull(MarkdownEditing.tableLines("a | b", 1))
    }

    @Test fun `tab moves through the cells`() {
        fun tab(marked: String): String? {
            val (t, sel) = draft(marked)
            return MarkdownEditing.nextCell(t, sel)?.let(::shown)
        }
        assertEquals("| Name | ‸ |\n| --- | --- |\n|  |  |", tab("| Name‸ |  |\n| --- | --- |\n|  |  |"))
        // From the header's last cell to the first body cell, past the divider.
        assertEquals("| Name | Status |\n| --- | --- |\n| ‸ |  |", tab("| Name | Status‸ |\n| --- | --- |\n|  |  |"))
        // From the last cell, a new row.
        assertEquals("| A | B |\n| --- | --- |\n| 1 | 2 |\n| ‸ |  |", tab("| A | B |\n| --- | --- |\n| 1 | 2‸ |"))
        // An escaped pipe is not a cell edge.
        assertEquals("| a \\| b | ‸c |\n| --- | --- |", tab("| a‸ \\| b | c |\n| --- | --- |"))
        assertNull(tab("not‸ a table"))
    }

    /** A selection past the end of the text (the toolbar a moment behind a send) never traps. */
    @Test fun `a stale selection is clamped`() {
        val past = MarkdownSelection(40, 3)
        for (action in MarkdownAction.entries) {
            MarkdownEditing.isActive(action, "- a", past)
            MarkdownEditing.apply(action, "", past)
        }
        assertNull(MarkdownEditing.newline("", past))
        assertNull(MarkdownEditing.tableLines("", 9))
        assertEquals(MarkdownSelection(3, 0), MarkdownEditing.clamp(past, "abc"))
    }

    /** What the toolbar types parses back as the structure it means. */
    @Test fun `toolbar output parses`() {
        var e = MarkdownEditing.apply(MarkdownAction.BULLET, "", MarkdownSelection(0))
        e = e.copy(text = e.text + "one")
        e = MarkdownEditing.newline(e.text, MarkdownSelection(e.text.length))!!
        e = MarkdownEditing.apply(MarkdownAction.INDENT, e.text, MarkdownSelection(e.location, e.length))
        e = e.copy(text = e.text + "nested")
        assertEquals(
            listOf(MarkdownBlock.ListBlock(MarkdownList(false, 1, listOf(MarkdownListItem("one", children = listOf(MarkdownList(false, 1, listOf(MarkdownListItem("nested"))))))))),
            MarkdownParser.parse(e.text),
        )
        val table = MarkdownEditing.apply(MarkdownAction.TABLE, "", MarkdownSelection(0))
        val t = (MarkdownParser.parse(table.text).first() as MarkdownBlock.Table).table
        assertEquals(2, t.header.size)
        assertEquals(1, t.rows.size)
    }

    @Test fun `highlight spans`() {
        val spans = MarkdownHighlight.spans("## Title\n- **bold** and `code`\n```\n**not bold**\n```")
        assertTrue(MarkdownSpan(MarkdownSpan.Kind.Heading(2), 0, 8) in spans)
        assertTrue(MarkdownSpan(MarkdownSpan.Kind.Marker, 9, 1) in spans)
        assertTrue(MarkdownSpan(MarkdownSpan.Kind.Bold, 11, 8) in spans)
        assertTrue(MarkdownSpan(MarkdownSpan.Kind.Syntax, 11, 2) in spans)
        assertTrue(MarkdownSpan(MarkdownSpan.Kind.Code, 24, 6) in spans)
        assertTrue(spans.any { it.kind == MarkdownSpan.Kind.Fence })
        // Inside the fence nothing is bold.
        assertEquals(1, spans.count { it.kind == MarkdownSpan.Kind.Bold })
        assertEquals(listOf(0 to 4), MarkdownHighlight.spans("*it* and **b**").filter { it.kind == MarkdownSpan.Kind.Italic }.map { it.start to it.length })
    }
}
