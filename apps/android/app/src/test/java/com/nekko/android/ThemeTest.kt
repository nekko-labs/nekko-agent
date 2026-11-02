package com.nekko.android

import androidx.compose.ui.graphics.Color
import com.nekko.android.ui.theme.DarkPalette
import com.nekko.android.ui.theme.THEME_PRESETS
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.android.ui.theme.withPreset
import com.nekko.android.ui.theme.ThemeResolver
import com.nekko.protocol.Appearance
import com.nekko.protocol.Appearance.ThemeMode
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTest {
    private val darkOrange = Appearance(ThemeMode.DARK, accent = 0xFFFB923CL)

    @Test
    fun `same as computer uses its mode and accent, the phone setting until it answers`() {
        val r = ThemeResolver.resolve(ThemeChoice.COMPUTER, darkOrange, systemDark = false)
        assertTrue(r.dark)
        assertEquals(0xFFFB923CL, r.accent)
        // Computer on System, or not heard from yet: the phone's own setting.
        assertTrue(ThemeResolver.resolve(ThemeChoice.COMPUTER, Appearance(ThemeMode.SYSTEM), systemDark = true).dark)
        assertFalse(ThemeResolver.resolve(ThemeChoice.COMPUTER, null, systemDark = false).dark)
        assertNull(ThemeResolver.resolve(ThemeChoice.COMPUTER, null, systemDark = false).accent)
    }

    @Test
    fun `a phone choice ignores the computer, accent included`() {
        assertFalse(ThemeResolver.resolve(ThemeChoice.LIGHT, darkOrange, systemDark = true).dark)
        assertTrue(ThemeResolver.resolve(ThemeChoice.DARK, null, systemDark = false).dark)
        assertTrue(ThemeResolver.resolve(ThemeChoice.SYSTEM, darkOrange.copy(theme = ThemeMode.LIGHT), systemDark = true).dark)
        assertNull(ThemeResolver.resolve(ThemeChoice.DARK, darkOrange, systemDark = false).accent)
    }

    @Test
    fun `a preset brings its mode, accent and surfaces, the computer's preset too`() {
        val nebula = ThemeResolver.resolve(ThemeChoice("nebula"), darkOrange, systemDark = false)
        assertTrue("Nebula is drawn dark whatever the phone says", nebula.dark)
        assertEquals("nebula", nebula.preset?.id)
        assertNull("a chosen preset ignores the computer's accent", nebula.accent)
        val p = DarkPalette.withPreset(nebula.preset, nebula.accent, dark = true)
        assertEquals(Color(0xFF9D8CE6), p.accent)
        assertEquals(Color(0xFF0B0A12), p.paper)
        assertEquals(Color(0xFFECE9F5), p.userInk)
        // A light preset's surfaces don't go on a dark palette, and System, Light and Dark keep Nekko's accent.
        assertEquals(DarkPalette.paper, DarkPalette.withPreset(ThemePreset.find("solar"), null, dark = true).paper)
        assertEquals(DarkPalette.accent, DarkPalette.withPreset(ThemePreset.find("dark"), null, dark = true).accent)
        // Match my computer draws the computer's preset under its own accent.
        val matched = ThemeResolver.resolve(ThemeChoice.COMPUTER, darkOrange.copy(preset = "nebula"), systemDark = false)
        assertEquals("nebula", matched.preset?.id)
        assertEquals(Color(0xFFFB923C), DarkPalette.withPreset(matched.preset, matched.accent, dark = true).accent)
        assertEquals(Color(0xFF0B0A12), DarkPalette.withPreset(matched.preset, matched.accent, dark = true).paper)
    }

    @Test
    fun `the catalog has the desktop's presets and families`() {
        assertEquals(listOf("system", "light", "dark"), THEME_PRESETS.take(3).map { it.id })
        assertTrue(ThemePreset.named.none { it.isBasic || it.family != null })
        assertTrue(ThemePreset.families.any { (f, v) -> f == "Blueberry" && v.map { it.label } == listOf("White", "Colourful", "Dark") })
        assertEquals(ThemeChoice("x-cyber-dark"), ThemeChoice.from("x-cyber-dark"))
    }

    @Test
    fun `unknown stored choice falls back to same as computer`() {
        assertEquals(ThemeChoice.COMPUTER, ThemeChoice.from(null))
        assertEquals(ThemeChoice.COMPUTER, ThemeChoice.from("sepia"))
        assertEquals(ThemeChoice.DARK, ThemeChoice.from("dark"))
    }

    @Test
    fun `appearance decodes the event and the settings the same way, nothing else`() {
        val event = Appearance.from(Json.parseToJsonElement("""{"theme":"dark","themePreset":"nebula","accent":"#fb923c"}"""))
        assertEquals(Appearance(ThemeMode.DARK, "nebula", 0xFFFB923CL, null), event)
        // settings:get carries far more; only the look is read.
        val settings = Appearance.from(Json.parseToJsonElement("""{"theme":"sepia","accent":"orange","accent2":"#22D3EE","providers":[{"apiKey":"x"}]}"""))
        assertEquals(Appearance(ThemeMode.SYSTEM, null, null, 0xFF22D3EEL), settings)
        assertEquals(Appearance(), Appearance.from(null))
    }
}
