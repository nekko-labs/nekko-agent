package com.nekko.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What Android Auto reads aloud of a reply (#2782): plain words, at most about 200 characters. */
class CarReplyTest {
    @Test fun markdownBecomesPlainWords() {
        assertEquals("Done. Fixed the login test in auth.ts PR (link). Details below.",
            CarReply.spoken("## Done\n\n**Fixed** the login test in `auth.ts` [PR](https://github.com/o/r/pull/1) https://ci.example/run/2.\n\n- Details below."))
        assertEquals("Run this: (code). then retry.", CarReply.spoken("Run this:\n```bash\nnpm test\n```\nthen retry."))
    }

    @Test fun longRepliesStopAtAWord() {
        val s = CarReply.spoken(List(80) { "word$it" }.joinToString(" "))
        assertTrue(s.length <= CarReply.MAX + 1)
        assertTrue(s.endsWith("…"))
        assertTrue(!s.dropLast(1).endsWith(" "))
    }

    @Test fun theNewestReplyWithWords() {
        val m = listOf(
            ChatMessage("a", "assistant", "Earlier"), ChatMessage("u", "user", "go"),
            ChatMessage("b", "assistant", "**All** green."), ChatMessage("t", "tool", "x"), ChatMessage("c", "assistant", "  "),
        )
        assertEquals("All green.", CarReply.latest(m))
        assertNull(CarReply.latest(listOf(ChatMessage("u", "user", "hi"))))
    }
}
