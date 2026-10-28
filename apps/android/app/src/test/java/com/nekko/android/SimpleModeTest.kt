package com.nekko.android

import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SimpleMode
import com.nekko.android.data.SimpleVisibility
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Simple and Expert's catalogue and saved choices (the desktop's simple-mode.test.ts). */
class SimpleModeTest {
    @Test fun `by default Simple shows only the model`() {
        val simple = SimpleMode.ITEMS.filter { SimpleMode.shown(it.id, expert = false, choices = emptyMap()) }.map { it.id }
        assertEquals(listOf("model"), simple)
        assertTrue(SimpleMode.ITEMS.all { SimpleMode.shown(it.id, expert = true, choices = emptyMap()) })
    }

    @Test fun `each choice in each mode`() {
        val show = mapOf("effort" to SimpleVisibility.SHOW)
        assertTrue(SimpleMode.shown("effort", false, show))
        assertTrue(SimpleMode.shown("effort", true, show))
        val expert = mapOf("model" to SimpleVisibility.EXPERT)
        assertFalse(SimpleMode.shown("model", false, expert))
        assertTrue(SimpleMode.shown("model", true, expert))
        val hide = mapOf("context" to SimpleVisibility.HIDE)
        assertFalse(SimpleMode.shown("context", false, hide))
        assertFalse(SimpleMode.shown("context", true, hide))
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
            mapOf("effort" to SimpleVisibility.SHOW),
            SimpleMode.parse("""{"effort":"show","nope":"hide","context":"sometimes","model":"show","thinking":3}"""),
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
        assertEquals(emptyMap<String, SimpleVisibility>(), SimpleMode.with(choices, "context", SimpleVisibility.EXPERT))
    }

    @Test fun `ids match the desktop catalogue's phone items`() {
        assertEquals(
            listOf("changes", "hardware", "ph-subtitle", "model", "effort", "context", "ph-policy", "thinking", "ph-git", "terminal", "ph-monitors"),
            SimpleMode.ITEMS.map { it.id },
        )
    }
}
