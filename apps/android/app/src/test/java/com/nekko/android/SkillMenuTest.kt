package com.nekko.android

import com.nekko.android.chat.SkillMenu
import com.nekko.protocol.SkillSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SkillMenuTest {
    private val skills = listOf(
        SkillSummary("plan", "Break the work into steps", "Research & planning", "builtin"),
        SkillSummary("review", "Review the code for bugs", "Code quality", "builtin"),
        SkillSummary("prereview", "Check before a review", "Imported", "claude"),
    )

    @Test fun `the menu opens on a leading slash and closes at the first space`() {
        assertEquals("", SkillMenu.query("/"))
        assertEquals("rev", SkillMenu.query("/rev"))
        assertNull(SkillMenu.query("/review this"))
        assertNull(SkillMenu.query(""))
        assertEquals(SkillMenu.Trigger("pl", 0), SkillMenu.trigger("/pl"))
    }

    @Test fun `the menu opens on a slash typed after existing text`() {
        assertEquals(SkillMenu.Trigger("", 18), SkillMenu.trigger("Help me with this /"))
        assertEquals(SkillMenu.Trigger("pl", 18), SkillMenu.trigger("Help me with this /pl"))
        assertEquals(SkillMenu.Trigger("", 5), SkillMenu.trigger("line\n/"))
        assertEquals("rev", SkillMenu.query("hello /rev"))
        assertEquals("", SkillMenu.query("tab\t/"))
    }

    @Test fun `a slash inside a word, a url or before more text does not open the menu`() {
        assertNull(SkillMenu.query("a/b"))
        assertNull(SkillMenu.query("https://x.com/"))
        assertNull(SkillMenu.query("Help me / now"))
        assertNull(SkillMenu.query("Help me /pl "))
        assertNull(SkillMenu.query("Help me /pl\n"))
        assertNull(SkillMenu.query("Help me"))
    }

    @Test fun `picking a skill removes only the slash query`() {
        assertEquals("", SkillMenu.afterPick("/"))
        assertEquals("", SkillMenu.afterPick("/pl"))
        assertEquals("Help me with this ", SkillMenu.afterPick("Help me with this /"))
        assertEquals("Help me with this ", SkillMenu.afterPick("Help me with this /pl"))
        assertEquals("line\n", SkillMenu.afterPick("line\n/"))
        assertEquals("a/b", SkillMenu.afterPick("a/b"))
    }

    @Test fun `matches names and descriptions, names starting with the query first`() {
        assertEquals(listOf("review", "prereview"), SkillMenu.match(skills, "review").map { it.name })
        assertEquals(listOf("plan"), SkillMenu.match(skills, "steps").map { it.name })
        assertEquals(skills, SkillMenu.match(skills, ""))
        assertEquals(listOf("review", "prereview"), SkillMenu.match(skills, "REV").map { it.name })
    }

    @Test fun `a fully typed skill runs with the rest as input`() {
        assertEquals(skills[1] to "this file", SkillMenu.typed("/review   this file ", skills))
        assertEquals(skills[0] to "", SkillMenu.typed("/plan", skills))
        assertNull(SkillMenu.typed("/nope x", skills))
        assertNull(SkillMenu.typed("review x", skills))
    }

    @Test fun `sources read as where the skill came from`() {
        assertEquals("Built in", SkillMenu.sourceLabel("builtin"))
        assertEquals("Claude Code", SkillMenu.sourceLabel("claude"))
        assertEquals("other", SkillMenu.sourceLabel("other"))
    }
}
