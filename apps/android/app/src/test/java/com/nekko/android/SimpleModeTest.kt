package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SimpleContext
import com.nekko.android.data.SimpleMode
import com.nekko.android.data.SimpleVisibility
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Simple and Expert's catalogue and saved choices (the desktop's simple-mode.test.ts). */
class SimpleModeTest {
    @Test fun `Simple shows only the everyday controls when nothing is going on`() {
        val simple = SimpleMode.ITEMS.filter { SimpleMode.shown(it.id, expert = false, choices = emptyMap()) }.map { it.id }
        assertEquals(listOf("model", "effort", "asks", "context"), simple)
        val off = SimpleMode.ITEMS.filter { !SimpleMode.shown(it.id, expert = true, choices = emptyMap()) }.map { it.id }
        assertEquals(listOf("changes", "hardware", "pr-status", "ph-monitors"), off)
        val all = SimpleContext(localModel = true, changes = true, pr = true)
        assertTrue(SimpleMode.ITEMS.all { SimpleMode.shown(it.id, expert = true, choices = emptyMap(), context = all) })
    }

    @Test fun `Changes and PR status need something to show`() {
        assertFalse(SimpleMode.shown("changes", true, emptyMap()))
        assertTrue(SimpleMode.shown("changes", false, emptyMap(), SimpleContext(changes = true)))
        assertFalse(SimpleMode.shown("changes", false, mapOf("changes" to SimpleVisibility.EXPERT), SimpleContext(changes = true)))
        assertFalse(SimpleMode.shown("pr-status", false, emptyMap()))
        assertTrue(SimpleMode.shown("pr-status", false, emptyMap(), SimpleContext(pr = true)))
        assertFalse(SimpleMode.shown("ph-git", false, emptyMap(), SimpleContext(pr = true)))
    }

    @Test fun `each choice in each mode`() {
        val show = mapOf("thinking" to SimpleVisibility.SHOW)
        assertTrue(SimpleMode.shown("thinking", false, show))
        assertTrue(SimpleMode.shown("thinking", true, show))
        val expert = mapOf("model" to SimpleVisibility.EXPERT)
        assertFalse(SimpleMode.shown("model", false, expert))
        assertTrue(SimpleMode.shown("model", true, expert))
        val hide = mapOf("context" to SimpleVisibility.HIDE, "hardware" to SimpleVisibility.HIDE)
        assertFalse(SimpleMode.shown("context", false, hide))
        assertFalse(SimpleMode.shown("context", true, hide))
        assertFalse(SimpleMode.shown("hardware", true, hide, SimpleContext(localModel = true)))
    }

    @Test fun `monitors wait for a local model in both modes, unless pinned or hidden`() {
        val running = SimpleContext(localModel = true)
        for (id in listOf("hardware", "ph-monitors")) for (expert in listOf(false, true)) {
            assertFalse(SimpleMode.shown(id, expert, emptyMap()))
            assertTrue(SimpleMode.shown(id, expert, emptyMap(), running))
            assertTrue(SimpleMode.shown(id, expert, mapOf(id to SimpleVisibility.SHOW)))
            assertFalse(SimpleMode.shown(id, expert, mapOf(id to SimpleVisibility.HIDE), running))
        }
        // Only the monitors: other Expert-only controls stay out of Simple.
        assertFalse(SimpleMode.shown("thinking", false, emptyMap(), running))
    }

    @Test fun `monitors offer When running in place of Expert only`() {
        val hardware = SimpleMode.ITEMS.first { it.id == "hardware" }
        assertEquals(listOf(SimpleVisibility.AUTO, SimpleVisibility.SHOW, SimpleVisibility.HIDE), SimpleMode.options(hardware))
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.parse("""{"hardware":"expert","terminal":"auto"}"""))
    }

    @Test fun `unknown ids always show`() {
        assertTrue(SimpleMode.shown("no-such-control", false, mapOf("no-such-control" to SimpleVisibility.HIDE)))
        assertEquals(SimpleVisibility.SHOW, SimpleMode.visibility("no-such-control", emptyMap()))
    }

    @Test fun `bad saved values never crash`() {
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.parse("{not json"))
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.parse("[1,2]"))
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.parse(null))
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.parse(""))
        // Unknown ids, bad values and defaults are dropped; the rest is kept.
        assertEquals(
            mapOf("effort" to SimpleVisibility.EXPERT),
            SimpleMode.parse("""{"effort":"expert","nope":"hide","context":"sometimes","model":"show","thinking":3}"""),
        )
    }

    @Test fun `encode keeps only what differs from the default, and round-trips through prefs`() {
        var choices = SimpleMode.with(emptyMap(), "context", SimpleVisibility.HIDE)
        choices = SimpleMode.with(choices, "model", SimpleVisibility.SHOW)
        assertEquals(mapOf("context" to SimpleVisibility.HIDE), choices)
        val prefs = PhonePrefs(MapPrefStore())
        prefs.set(SimpleMode.CHOICES, SimpleMode.encode(choices))
        assertEquals("""{"context":"hide"}""", prefs.get(SimpleMode.CHOICES))
        assertEquals(choices, SimpleMode.parse(prefs.get(SimpleMode.CHOICES)))
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.with(choices, "context", SimpleVisibility.SHOW))
    }

    @Test fun `starting fresh saves the conversation's tokens from 85 percent of the window`() {
        val sources = listOf("conversation" to 112_000L, "system" to 9_000L)
        assertEquals(null, SimpleMode.freshSavings(169_999, 200_000, sources))
        assertEquals(112_000L, SimpleMode.freshSavings(170_000, 200_000, sources))
        assertEquals(null, SimpleMode.freshSavings(190_000, null, sources))
        assertEquals(null, SimpleMode.freshSavings(190_000, 200_000, listOf("system" to 9_000L)))
    }

    @Test fun `ids match the desktop catalogue's phone items`() {
        assertEquals(
            listOf("changes", "hardware", "ph-subtitle", "model", "effort", "asks", "context", "run-settings", "thinking", "pr-status", "ph-git", "ph-monitors"),
            SimpleMode.ITEMS.map { it.id },
        )
    }
}
