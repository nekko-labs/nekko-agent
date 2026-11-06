package com.nekko.android

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.nekko.android.ui.chat.MarkdownDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** MD-6: the message box's typing rules as the keyboard delivers them (a whole new value per keystroke). */
class MarkdownDraftTest {
    private var text = ""
    private val draft = MarkdownDraft()
    private val set: (String) -> Unit = { text = it }

    /** Type [s] at the caret, as the keyboard does: one new value. */
    private fun type(s: String) {
        val old = draft.valueFor(text)
        val sel = old.selection
        val next = old.text.replaceRange(sel.min, sel.max, s)
        draft.changed(old, TextFieldValue(next, TextRange(sel.min + s.length)), set)
    }

    private fun caret() = draft.valueFor(text).selection

    @Test fun `return continues a list and ends it on an empty item`() {
        type("- one")
        type("\n")
        assertEquals("- one\n- ", text)
        assertEquals(TextRange(8), caret())
        type("two")
        type("\n")
        type("\n")
        assertEquals("an empty item ends the list", "- one\n- two\n", text)
        // Plain text: an ordinary newline.
        type("plain")
        type("\n")
        assertEquals("- one\n- two\nplain\n", text)
    }

    @Test fun `a numbered list counts again when a line goes`() {
        text = "1. a\n2. b\n3. c"
        draft.value = TextFieldValue(text, TextRange(9)) // after "2. b"
        // Backspace over "\n2. b" as one edit (the keyboard deleting a selected line).
        val old = draft.valueFor(text)
        draft.changed(old, TextFieldValue("1. a\n3. c", TextRange(4)), set)
        assertEquals("1. a\n2. c", text)
    }

    @Test fun `text set from outside puts the caret at its end`() {
        text = "dictated"
        assertEquals(TextRange(8), caret())
    }

    @Test fun `tab moves through a table and nests a list item`() {
        text = "| A | B |\n| --- | --- |"
        draft.value = TextFieldValue(text, TextRange(3))
        assertTrue(draft.tab(text, shift = false, set))
        assertEquals(TextRange(6), caret())
        text = "- a\n- b"
        draft.value = TextFieldValue(text, TextRange(7))
        assertTrue(draft.tab(text, shift = false, set))
        assertEquals("- a\n  - b", text)
        assertTrue(draft.tab(text, shift = true, set))
        assertEquals("- a\n- b", text)
        // Plain text: Tab is the keyboard's (focus moves on).
        text = "plain"
        assertFalse(draft.tab(text, shift = false, set))
    }

    @Test fun `a paste goes over the selection`() {
        text = "say hi now"
        draft.value = TextFieldValue(text, TextRange(4, 6))
        assertEquals(4, draft.insert(text, "**hello**", set))
        assertEquals("say **hello** now", text)
        assertEquals(TextRange(13), caret())
    }
}
