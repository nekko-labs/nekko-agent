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

    @Test fun `automations decode with their cadence and last result`() {
        val t = AutomationTask.list(json("""[{"id":"t1","title":"Nightly tests","kind":"recurring","intervalMs":86400000,"status":"active","runCount":3,"lastResult":"All 40 passed.","lastRunAt":5},{"title":"no id"}]"""))
        assertEquals(listOf("Nightly tests"), t.map { it.title })
        assertEquals("Every day", t[0].cadence { "" })
        assertEquals("All 40 passed.", t[0].lastResult)
        assertEquals("1.5 hours", AutomationTask.interval(90 * 60_000L))
        assertEquals("45 minutes", AutomationTask.interval(45 * 60_000L))
        assertEquals("hour", AutomationTask.interval(60 * 60_000L))
        assertEquals("Once", AutomationTask(id = "x", title = "x", kind = AutomationTask.Kind.SCHEDULED, status = "active").cadence { "" })
        assertEquals("Until it’s done", AutomationTask(id = "x", title = "x", kind = AutomationTask.Kind.BACKGROUND, status = "active", untilDone = true).cadence { "" })
        val w = AutomationWorkflow.list(json("""[{"id":"w1","name":"Review PRs","category":"Code","enabled":true,"stepCount":2,"lastStatus":"failure"}]"""))
        assertEquals("Code · 2 steps", w[0].detail)
        assertEquals("failure", w[0].lastStatus)
    }

    @Test fun `usage and limits`() {
        val u = UsageSummary.from(json("""{"totalInput":1000,"totalOutput":500,"totalCost":1.25,"byModel":[{"model":"claude-opus-5.5","input":600,"output":300,"cost":1}],"daily":[{"date":"2026-10-19","input":10,"output":5,"cost":0.25}]}"""))!!
        assertEquals(1500L, u.totalTokens)
        assertEquals(900L, u.models.single().tokens)
        assertEquals(15L, u.days.single().tokens)
        val l = ProviderLimits.from(json("""{"planType":"max","windows":[{"id":"w","label":"5 hours","usedPercent":140,"resetAt":9,"status":"warning"}]}"""))!!
        assertEquals("max", l.planType)
        assertEquals("used percent is held to 0-100", 100.0, l.windows.single().usedPercent, 0.0)
        assertEquals(null, ProviderLimits.from(json("null")))
    }
}
