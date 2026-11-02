package com.nekko.protocol

import com.nekko.protocol.MarkdownBlock.Code
import com.nekko.protocol.MarkdownBlock.Heading
import com.nekko.protocol.MarkdownBlock.ListBlock
import com.nekko.protocol.MarkdownBlock.Paragraph
import com.nekko.protocol.MarkdownBlock.Quote
import com.nekko.protocol.MarkdownBlock.Rule
import com.nekko.protocol.MarkdownBlock.Table
import com.nekko.protocol.MarkdownListItem.Task
import com.nekko.protocol.MarkdownTable.Alignment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MD-6: the phone's Markdown block tree, with the iPhone's MarkdownTests cases (MD-1). */
class MarkdownTreeTest {
    private fun item(text: String, task: Task? = null, children: List<MarkdownList> = emptyList()) = MarkdownListItem(text, task, children)
    private fun bullets(vararg items: MarkdownListItem) = MarkdownList(false, 1, items.toList())
    private fun numbers(start: Int, vararg items: MarkdownListItem) = MarkdownList(true, start, items.toList())
    private fun parse(s: String) = MarkdownParser.parse(s)

    @Test fun `parses the blocks agent replies use`() {
        val md = "# Plan\nSome **bold** text\ncontinued.\n\n```swift\nlet x = 1\n```\n> quoted\n> - in a list\n\n---\n## Next ##"
        assertEquals(
            listOf(
                Heading(1, "Plan"),
                Paragraph("Some **bold** text\ncontinued."),
                Code("swift", "let x = 1", true),
                Quote(listOf(Paragraph("quoted"), ListBlock(bullets(item("in a list"))))),
                Rule,
                Heading(2, "Next"),
            ),
            parse(md),
        )
    }

    @Test fun `nests lists three deep`() {
        val md = "- one\n  - two\n    - three\n  - two again\n- back to one"
        assertEquals(
            listOf(ListBlock(bullets(item("one", null, listOf(bullets(item("two", null, listOf(bullets(item("three")))), item("two again")))), item("back to one")))),
            parse(md),
        )
    }

    @Test fun `mixes bullet and numbered lists`() {
        val md = "1. First\n   - detail\n   - more\n2. Second\n   1. sub one\n   2. sub two\n- a bullet after the numbers"
        assertEquals(
            listOf(
                ListBlock(numbers(1, item("First", null, listOf(bullets(item("detail"), item("more")))), item("Second", null, listOf(numbers(1, item("sub one"), item("sub two")))))),
                ListBlock(bullets(item("a bullet after the numbers"))),
            ),
            parse(md),
        )
    }

    @Test fun `an ordered list keeps its start number`() {
        assertEquals(listOf(ListBlock(numbers(3, item("three"), item("four")))), parse("3) three\n4) four"))
    }

    @Test fun `wrapped and continued lines hang under their item`() {
        val md = "- a long item\n  that wraps\n  - child\n  more for the parent\n- lazy\ncontinuation\n\n  second paragraph of lazy"
        assertEquals(
            listOf(ListBlock(bullets(item("a long item\nthat wraps\nmore for the parent", null, listOf(bullets(item("child")))), item("lazy\ncontinuation\n\nsecond paragraph of lazy")))),
            parse(md),
        )
    }

    @Test fun `a blank line then an unindented line ends the list`() {
        assertEquals(listOf(ListBlock(bullets(item("a"))), Paragraph("after")), parse("- a\n\nafter"))
        assertEquals(listOf(ListBlock(bullets(item("a", null, listOf(bullets(item("b"))))))), parse("- a\n\n  - b"))
    }

    @Test fun `task items become checkboxes`() {
        assertEquals(
            listOf(ListBlock(bullets(item("todo", Task.OPEN), item("done", Task.DONE), item("also", Task.DONE), item("", Task.OPEN), item("[link](u)")))),
            parse("- [ ] todo\n- [x] done\n- [X] also\n- [ ]\n- [link](u)"),
        )
    }

    @Test fun `not every dash or number is a list`() {
        assertEquals(listOf(Paragraph("**bold** start\n-not a list\n2026. A year.")), parse("**bold** start\n-not a list\n2026. A year."))
        assertEquals(listOf(Rule), parse("* * *"))
    }

    @Test fun `markers change by depth`() {
        assertEquals(listOf("•", "◦", "▪", "•"), (0 until 4).map { MarkdownParser.marker(false, it, 1) })
        assertEquals("12.", MarkdownParser.marker(true, 0, 12))
        assertEquals("b.", MarkdownParser.marker(true, 1, 2))
        assertEquals("aa.", MarkdownParser.marker(true, 1, 27))
        assertEquals("iv.", MarkdownParser.marker(true, 2, 4))
        assertEquals("mcmxciv.", MarkdownParser.marker(true, 2, 1994))
    }

    @Test fun `parses a table with alignment`() {
        val md = "| Name | Status | Count |\n|:-----|:------:|------:|\n| Nekko | **done** | 3 |\n| Relay | open | 12 |"
        assertEquals(
            listOf(Table(MarkdownTable(listOf("Name", "Status", "Count"), listOf(Alignment.LEADING, Alignment.CENTER, Alignment.TRAILING), listOf(listOf("Nekko", "**done**", "3"), listOf("Relay", "open", "12"))))),
            parse(md),
        )
    }

    @Test fun `escaped pipes stay in the cell`() {
        val t = (parse("| a | b |\n|---|---|\n| x \\| y | `z` |").first() as Table).table
        assertEquals(listOf(listOf("x | y", "`z`")), t.rows)
        assertEquals("| a | b |\n| --- | --- |\n| x \\| y | `z` |", t.markdown)
    }

    @Test fun `ragged rows are padded to the header`() {
        val t = (parse("a | b | c\n--- | --- | ---\n| 1 |\n1 | 2 | 3 | 4").first() as Table).table
        assertEquals(listOf(listOf("1", "", ""), listOf("1", "2", "3")), t.rows)
    }

    @Test fun `a table needs a matching divider`() {
        assertEquals(listOf(Paragraph("a | b"), Rule), parse("a | b\n---"))
        assertEquals(listOf(Paragraph("| a | b |\n|---|")), parse("| a | b |\n|---|"))
    }

    @Test fun `a table ends at a blank or pipeless line`() {
        assertEquals(listOf(Table(MarkdownTable(listOf("a"), listOf(Alignment.LEADING), listOf(listOf("1")))), Paragraph("after")), parse("| a |\n|---|\n| 1 |\nafter"))
    }

    @Test fun `table copies and accessibility`() {
        val t = MarkdownTable(listOf("Name", "Status"), listOf(Alignment.LEADING, Alignment.CENTER), listOf(listOf("**Nekko**", "done"), listOf("[Relay](https://x.dev)", "a\tb")))
        assertEquals("Name\tStatus\nNekko\tdone\nRelay\ta b", t.tabSeparated)
        assertEquals("| Name | Status |\n| --- | :---: |\n| **Nekko** | done |\n| [Relay](https://x.dev) | a\tb |", t.markdown)
        assertEquals("Row 2 of 2: Name, Relay; Status, a\tb", t.accessibilityRow(1))
        assertFalse(t.isLarge)
        assertTrue(MarkdownTable(List(5) { "c" }, emptyList(), emptyList()).isLarge)
        assertTrue(MarkdownTable(listOf("c"), emptyList(), List(13) { listOf("x") }).isLarge)
    }

    @Test fun `an unclosed fence still shows its code`() {
        assertEquals(listOf(Code("", "streaming…", false)), parse("```\nstreaming…"))
        assertEquals(listOf(Code("mermaid", "graph TD", true)), parse("~~~mermaid\ngraph TD\n~~~"))
        // Blank lines inside a fence are code, and a shorter run doesn't close it.
        assertEquals(listOf(Code("", "a\n\n```\nb", true)), parse("````\na\n\n```\nb\n````"))
    }

    @Test fun `segments split only where nothing carries across`() {
        val md = "# A\npara\n\n- x\n\n  - y\n\n```\none\n\ntwo\n```\n\nlast"
        assertEquals(listOf("# A\npara", "- x\n\n  - y", "```\none\n\ntwo\n```", "last"), MarkdownParser.segments(md))
    }

    /** The cached, segment-by-segment parse is the same as one pass, so streaming can't change the result. */
    @Test fun `blocks match a whole parse, at every prefix as a reply streams`() {
        val md = """
            # Report

            Intro with `code` and a [link](https://example.com).

            1. Step one
               - sub
                 continued

               - after a blank
            2. Step two

            | a | b |
            |---|:-:|
            | 1 | 2 |

            > quote
            > more

            ```mermaid
            graph TD

            A --> B
            ```

            - [ ] open
            - [x] done
            ---
            tail
        """.trimIndent()
        assertEquals(MarkdownParser.parse(md), MarkdownParser.blocks(md))
        for (n in 1..md.length) {
            val prefix = md.substring(0, n)
            assertEquals("prefix $n", MarkdownParser.parse(prefix), MarkdownParser.blocks(prefix))
        }
    }

    @Test fun `plain text`() {
        assertEquals("a b c d f", MarkdownParser.plainText("**a** `b` ~~c~~ [d](e) ![f](g)"))
    }

    @Test fun `strikethrough is an inline style, and an unclosed one stays text`() {
        val spans = Markdown.inline("keep ~~gone~~ and ~~ not ~~ or ~~open")
        assertEquals(listOf("keep ", "gone", " and ~~ not ~~ or ~~open"), spans.map { it.text })
        assertEquals(setOf(Markdown.Style.STRIKE), spans[1].styles)
        assertEquals(emptySet<Markdown.Style>(), spans[2].styles)
    }
}
