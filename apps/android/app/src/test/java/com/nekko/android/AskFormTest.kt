package com.nekko.android

import com.nekko.android.chat.AskForm
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskOption
import com.nekko.protocol.AskQuestion
import com.nekko.protocol.AskRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AskFormTest {
    private val single = AskQuestion("q1", "Scope", "Which one?", listOf(AskOption("A", null), AskOption("B", null)), multiSelect = false)
    private val multi = AskQuestion("q2", "Extras", "Which extras?", listOf(AskOption("X", null), AskOption("Y", null)), multiSelect = true)
    private val request = AskRequest("ask", listOf(single, multi), 0)

    @Test
    fun `single select replaces and toggles off`() {
        var f = AskForm().toggle(single, "A")
        assertEquals(listOf("A"), f.picked["q1"])
        f = f.toggle(single, "B")
        assertEquals(listOf("B"), f.picked["q1"])
        f = f.toggle(single, "B")
        assertEquals(emptyList<String>(), f.picked["q1"])
    }

    @Test
    fun `multi select accumulates`() {
        val f = AskForm().toggle(multi, "X").toggle(multi, "Y").toggle(multi, "X")
        assertEquals(listOf("Y"), f.picked["q2"])
    }

    @Test
    fun `complete needs a pick or a note for every question`() {
        var f = AskForm().toggle(single, "A")
        assertFalse(f.complete(request))
        f = f.note(multi, "   ")
        assertFalse(f.complete(request))
        f = f.note(multi, "something custom")
        assertTrue(f.complete(request))
    }

    @Test
    fun `answers trim notes and skip blank questions`() {
        val f = AskForm().toggle(single, "A").note(single, "  why not  ")
        assertEquals(listOf(AskAnswer("q1", listOf("A"), "why not")), f.answers(request))
    }
}
