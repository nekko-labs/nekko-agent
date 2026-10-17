package com.nekko.protocol

import com.nekko.protocol.Markdown.Piece
import com.nekko.protocol.Markdown.Span
import com.nekko.protocol.Markdown.Style
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    @Test
    fun blocksMatchTheIphoneParser() {
        val text = """
            # Plan
            Two lines
            of text.

            - one
              - nested
            - [ ] todo
            - [x] done
            1. first
            > quoted
            ---
            ```kotlin
              val x = 1
            ```
        """.trimIndent()
        assertEquals(
            listOf(
                Piece.Heading(1, "Plan"),
                Piece.Paragraph("Two lines\nof text."),
                Piece.Bullet(0, "•", "one"),
                Piece.Bullet(1, "•", "nested"),
                Piece.Bullet(0, "☐", "todo"),
                Piece.Bullet(0, "☑", "done"),
                Piece.Bullet(0, "1.", "first"),
                Piece.Quote("quoted"),
                Piece.Rule,
                Piece.Code("kotlin", "  val x = 1"),
            ),
            Markdown.parse(text),
        )
    }

    @Test
    fun aStreamingFenceShowsWhatArrived() {
        assertEquals(listOf(Piece.Paragraph("Here:"), Piece.Code("sh", "ls -la")), Markdown.parse("Here:\n```sh\nls -la"))
    }

    @Test
    fun hashWithoutSpaceIsText() {
        assertEquals(listOf(Piece.Paragraph("#hashtag")), Markdown.parse("#hashtag"))
    }

    @Test
    fun inlineStyles() {
        assertEquals(
            listOf(
                Span("A "),
                Span("bold", setOf(Style.BOLD)),
                Span(", "),
                Span("italic", setOf(Style.ITALIC)),
                Span(" and "),
                Span("code", setOf(Style.CODE)),
                Span("."),
            ),
            Markdown.inline("A **bold**, *italic* and `code`."),
        )
        assertEquals(
            listOf(Span("x "), Span("very ", setOf(Style.BOLD)), Span("much", setOf(Style.BOLD, Style.ITALIC))),
            Markdown.inline("x **very _much_**"),
        )
    }

    @Test
    fun linksKeepTheirUrlAndImagesStayText() {
        assertEquals(
            listOf(Span("See "), Span("the docs", setOf(Style.LINK), "https://nekkoagent.com/docs"), Span(".")),
            Markdown.inline("See [the docs](https://nekkoagent.com/docs)."),
        )
        assertEquals(listOf(Span("a cat here")), Markdown.inline("a ![cat](https://example.com/cat.png) here"))
        assertEquals(listOf(Span("image")), Markdown.inline("![](https://example.com/x.png)"))
    }

    @Test
    fun unclosedMarkersStayLiteral() {
        assertEquals(listOf(Span("**bo")), Markdown.inline("**bo"))
        assertEquals(listOf(Span("`unterminated")), Markdown.inline("`unterminated"))
        assertEquals(listOf(Span("[label](no-close")), Markdown.inline("[label](no-close"))
        assertEquals(listOf(Span("2 * 3 * 4")), Markdown.inline("2 * 3 * 4"))
    }

    @Test
    fun snakeCaseAndEscapesAreNotEmphasis() {
        assertEquals(listOf(Span("call my_func_name now")), Markdown.inline("call my_func_name now"))
        assertEquals(listOf(Span("*not italic*")), Markdown.inline("\\*not italic\\*"))
        assertEquals(listOf(Span("a "), Span("**", setOf(Style.CODE))), Markdown.inline("a `**`"))
    }

    @Test
    fun plainTextDropsMarkers() {
        assertEquals(
            "Title\n• go to docs now\nval x = 1",
            Markdown.plain("## Title\n- go to [docs](https://x.dev) **now**\n```\nval x = 1\n```"),
        )
    }
}
