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
        assertNull(SkillMenu.query("hello /rev"))
        assertNull(SkillMenu.query(""))
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
