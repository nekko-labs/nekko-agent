package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** MM-4: fence detection, the streaming rule, the size cap and the cache key, with the iPhone's MermaidRulesTests cases. */
class MermaidRulesTest {
    @Test fun `detects mermaid fences and files`() {
        assertTrue(MermaidRules.isMermaid("mermaid"))
        assertTrue(MermaidRules.isMermaid("Mermaid"))
        assertFalse(MermaidRules.isMermaid("swift"))
        assertFalse(MermaidRules.isMermaid(""))
        assertTrue(MermaidRules.isMermaidFile("flow.MMD"))
        assertTrue(MermaidRules.isMermaidFile("docs/arch.mermaid"))
        assertFalse(MermaidRules.isMermaidFile("notes.md"))
        // The parser hands the fence's language and whether it has closed.
        val code = MarkdownParser.parse("```mermaid\ngraph TD\nA-->B\n```").first() as MarkdownBlock.Code
        assertTrue(MermaidRules.isMermaid(code.language))
        assertEquals("graph TD\nA-->B", code.body)
        assertTrue(code.closed)
    }

    /** While a reply streams, the fence is drawn only once it closes, never per token. */
    @Test fun `no drawing before the fence closes`() {
        val reply = "Here:\n```mermaid\ngraph TD\nA-->B\n```\nDone."
        var draws = 0
        for (n in 1..reply.length) {
            for (b in MarkdownParser.blocks(reply.substring(0, n))) {
                if (b !is MarkdownBlock.Code || !MermaidRules.isMermaid(b.language)) continue
                val d = MermaidRules.decide(b.body, b.closed)
                if (d == MermaidRules.Decision.DRAW) draws++ else assertEquals(MermaidRules.Decision.WAIT_FOR_FENCE, d)
            }
        }
        // Drawable from the closing fence to the end: ``` closes it, then "\nDone." follows (7 more characters).
        assertEquals("drawable only after the fence closed", 7, draws)
        assertEquals(MermaidRules.Decision.WAIT_FOR_FENCE, MermaidRules.decide("graph TD", false))
    }

    @Test fun `the size cap`() {
        val big = "graph TD\n" + "A-->B\n".repeat(10_000)
        assertTrue(big.length > MermaidRules.MAX_SOURCE)
        assertEquals(MermaidRules.Decision.TOO_LARGE, MermaidRules.decide(big, true))
        assertEquals(MermaidRules.Decision.DRAW, MermaidRules.decide("graph TD\nA-->B", true))
    }

    @Test fun `the cache key separates source, theme and width`() {
        val k = MermaidRules.cacheKey("graph TD", false, 320, "12.1.0")
        assertEquals(64, k.length)
        assertEquals(k, MermaidRules.cacheKey("graph TD", false, 320, "12.1.0"))
        assertNotEquals(k, MermaidRules.cacheKey("graph LR", false, 320, "12.1.0"))
        assertNotEquals(k, MermaidRules.cacheKey("graph TD", true, 320, "12.1.0"))
        assertNotEquals(k, MermaidRules.cacheKey("graph TD", false, 360, "12.1.0"))
        assertNotEquals(k, MermaidRules.cacheKey("graph TD", false, 320, "12.2.0"))
        // Widths round down to steps, so a few dp of difference reuse the drawing.
        assertEquals(320, MermaidRules.drawWidth(358.0))
        assertEquals(360, MermaidRules.drawWidth(361.0))
        assertEquals(MermaidRules.WIDTH_STEP, MermaidRules.drawWidth(10.0))
    }

    @Test fun `kind for TalkBack`() {
        assertEquals("flowchart", MermaidRules.kind("graph TD\nA-->B"))
        assertEquals("sequence diagram", MermaidRules.kind("%% a comment\nsequenceDiagram\nA->>B: hi"))
        assertEquals("pie chart", MermaidRules.kind("pie title Pets"))
        assertEquals("diagram", MermaidRules.kind("nonsense"))
    }
}
