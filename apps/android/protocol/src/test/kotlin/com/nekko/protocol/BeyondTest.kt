package com.nekko.protocol

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** AN-29: the queue, saved prompts and search, with the iPhone's BeyondTests data. */
class BeyondTest {
    private fun json(s: String) = Json.parseToJsonElement(s)

    @Test fun `a skill's queued prompt shows as slash name input and can only be removed`() {
        val q = QueuedPrompt.list(json("""["first", {"text":"with a photo","images":[""]}, {"text":"Review.\n\nnow","skill":{"name":"review","input":"now"}}, 7]"""))
        assertEquals("a skill's prompt shows as /name input, never its instructions", listOf("first", "with a photo", "/review now"), q.map { it.shown })
        assertEquals(listOf(true, true, false), q.map { it.editable })
        assertEquals(1, q[1].images)
        assertEquals("the edit is checked against the text the computer holds", "Review.\n\nnow", q[2].text)
        assertEquals("""{"expect":"first","text":"first, edited"}""", QueuedPrompt.edit("first", "first, edited").toString())
        assertEquals("no text removes it", """{"expect":"first"}""", QueuedPrompt.edit("first", null).toString())
        // The session keeps both: what the composer shows and what an edit checks.
        val s = Session.from(json("""{"id":"s1","queue":["first",{"text":"Review.","skill":{"name":"review","input":"now"}}]}"""))!!
        assertEquals(listOf("first", "/review now"), s.queue)
        assertEquals(listOf("first", "Review."), s.queued.map { it.text })
    }

    @Test fun `saved prompts send their text, then what was typed`() {
        val p = PcSettings.from(json("""{"prompts":[{"id":"fix","name":"fix","body":"Find and fix the bug."},{"name":"broken"},{"name":" ","body":"x"}],"automationsPaused":true}"""))
        assertEquals(listOf(SavedPrompt("fix", "fix", "Find and fix the bug.")), p.prompts)
        assertEquals("Find and fix the bug.\n\nin login.ts", p.prompts[0].text("  in login.ts "))
        assertEquals("Find and fix the bug.", p.prompts[0].text(""))
        assertTrue(p.automationsPaused)
    }

    private val chats = listOf(
        """{"id":"s1","title":"Fix the login bug","updatedAt":5,"firstUserText":"Find the bug"}""",
        """{"id":"s2","title":"Café menu","updatedAt":9,"archivedAt":10,"lastReplyText":"Done with the RÉSUMÉ"}""",
        """{"id":"s3","title":"Newest","updatedAt":7}""",
        """{"id":"sub","title":"x","updatedAt":99,"parentSessionId":"s1"}""",
    ).map { SessionSummary.from(json(it))!! }

    @Test fun `search across completed chats`() {
        assertEquals("accents and case don't matter; completed chats count", listOf("s2"), ChatSearch.matches(chats, "cafe resume").map { it.id })
        assertEquals("every word, anywhere", listOf("s1"), ChatSearch.matches(chats, "BUG find").map { it.id })
        assertEquals(chats.size, ChatSearch.matches(chats, "  ").size)
        assertTrue(ChatSearch.matches(chats, "nothing like it").isEmpty())
        assertEquals("full-width letters fold too", "cafe", ChatSearch.fold("ＣＡＦÉ"))
    }
}
