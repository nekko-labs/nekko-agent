package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** #2453: the iPhone's ConversationContext tests, on Android. */
class ConversationContextTest {
    private val head = "Summary of the earlier conversation, compacted to save context:"

    @Test fun `only the exact opening is a summary`() {
        assertNull(ConversationContext.parts("## Summary\\nSome heading"))
        assertNull(ConversationContext.parts("Summary of the earlier conversation"))
        assertFalse(ConversationContext.isSummary("Fix the build"))
    }

    @Test fun `a summary alone has no prompt`() {
        val text = "$head\n- Task: tidy the settings page\n- Folder: nekko-agent"
        assertEquals(text to null, ConversationContext.parts(text))
    }

    @Test fun `the prompt merged after the last separator stays outside, a rule inside the summary stays in`() {
        val summary = "$head\nFirst part\n\n---\n\nSecond part"
        val (s, prompt) = ConversationContext.parts("$summary\n\n---\n\nNow add a dark mode")!!
        assertEquals(summary, s)
        assertEquals("Now add a dark mode", prompt)
    }

    @Test fun `leading spaces don't hide it`() {
        assertEquals(true, ConversationContext.isSummary("  \n$head\nx"))
    }
}
