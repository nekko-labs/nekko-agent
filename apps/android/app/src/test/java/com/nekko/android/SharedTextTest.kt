package com.nekko.android

import com.nekko.android.share.SharedText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedTextTest {
    @Test
    fun `plain text is kept, trimmed`() {
        assertEquals("Summarise this", SharedText.from("text/plain", "  Summarise this \n", null))
    }

    @Test
    fun `a browser share puts the page title above the link`() {
        assertEquals(
            "Kotlin 2.4 released\n\nhttps://example.com/k24",
            SharedText.from("text/plain", "https://example.com/k24", "Kotlin 2.4 released"),
        )
    }

    @Test
    fun `the subject is dropped when the text already has it`() {
        assertEquals(
            "Kotlin 2.4 released https://example.com/k24",
            SharedText.from("text/plain", "Kotlin 2.4 released https://example.com/k24", "Kotlin 2.4 released"),
        )
    }

    @Test
    fun `a subject alone still makes a prompt`() {
        assertEquals("Only a title", SharedText.from("text/plain", null, "Only a title"))
    }

    @Test
    fun `nothing usable is null`() {
        assertNull(SharedText.from("text/plain", null, null))
        assertNull(SharedText.from("text/plain", "   \n\t ", ""))
        assertNull(SharedText.from("image/png", "caption", null))
    }

    @Test
    fun `a missing type is accepted, any text subtype too`() {
        assertEquals("hi", SharedText.from(null, "hi", null))
        assertEquals("<b>hi</b>", SharedText.from("text/html", "<b>hi</b>", null))
    }

    @Test
    fun `windows newlines and control characters are cleaned`() {
        assertEquals("a\nb\tc", SharedText.from("text/plain", "a\r\nb\tc\u0000\u0007", null))
    }

    @Test
    fun `a very long share is cut and says so`() {
        val out = SharedText.from("text/plain", "x".repeat(SharedText.MAX_CHARS + 500), null)!!
        assertTrue(out.endsWith(SharedText.CUT_NOTE))
        assertEquals(SharedText.MAX_CHARS, out.length - SharedText.CUT_NOTE.length)
    }

    @Test
    fun `the cut never splits an emoji`() {
        val text = "x".repeat(SharedText.MAX_CHARS - 1) + "😀" + "tail"
        val out = SharedText.from("text/plain", text, null)!!
        val kept = out.removeSuffix(SharedText.CUT_NOTE)
        assertEquals(SharedText.MAX_CHARS - 1, kept.length)
        assertTrue(!Character.isHighSurrogate(kept.last()))
    }

    @Test
    fun `exactly the limit is not cut`() {
        val text = "y".repeat(SharedText.MAX_CHARS)
        assertEquals(text, SharedText.from("text/plain", text, null))
    }
}
