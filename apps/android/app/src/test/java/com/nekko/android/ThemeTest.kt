package com.nekko.android

import androidx.compose.ui.graphics.Color
import com.nekko.android.ui.theme.DarkPalette
import com.nekko.android.ui.theme.THEME_PRESETS
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.android.ui.theme.withPreset
import com.nekko.android.ui.theme.ThemeResolver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTest {
    @Test
    fun `light and dark are the phone's choice, and match this phone follows its setting`() {
        assertFalse(ThemeResolver.resolve(ThemeChoice.LIGHT, systemDark = true).dark)
        assertTrue(ThemeResolver.resolve(ThemeChoice.DARK, systemDark = false).dark)
        assertTrue(ThemeResolver.resolve(ThemeChoice.SYSTEM, systemDark = true).dark)
        assertFalse(ThemeResolver.resolve(ThemeChoice.SYSTEM, systemDark = false).dark)
        assertNull(ThemeResolver.resolve(ThemeChoice.DARK, systemDark = false).accent)
    }

    @Test
    fun `a preset brings its mode, accent and surfaces`() {
        val nebula = ThemeResolver.resolve(ThemeChoice("nebula"), systemDark = false)
        assertTrue("Nebula is drawn dark whatever the phone says", nebula.dark)
        assertEquals("nebula", nebula.preset?.id)
        assertNull("a preset keeps its own accent", nebula.accent)
        val p = DarkPalette.withPreset(nebula.preset, nebula.accent, dark = true)
        assertEquals(Color(0xFF9D8CE6), p.accent)
        assertEquals(Color(0xFF0B0A12), p.paper)
        assertEquals(Color(0xFFECE9F5), p.userInk)
        // A light preset's surfaces don't go on a dark palette, and System, Light and Dark keep Nekko's accent.
        assertEquals(DarkPalette.paper, DarkPalette.withPreset(ThemePreset.find("solar"), null, dark = true).paper)
        assertEquals(DarkPalette.accent, DarkPalette.withPreset(ThemePreset.find("dark"), null, dark = true).accent)
    }

    @Test
    fun `the catalog has the desktop's presets and families`() {
        assertEquals(listOf("system", "light", "dark"), THEME_PRESETS.take(3).map { it.id })
        assertTrue(ThemePreset.named.none { it.isBasic || it.family != null })
        assertTrue(ThemePreset.families.any { (f, v) -> f == "Blueberry" && v.map { it.label } == listOf("White", "Colourful", "Dark") })
        assertEquals(ThemeChoice("x-cyber-dark"), ThemeChoice.from("x-cyber-dark"))
    }

    @Test
    fun `an unknown stored choice, the retired match my computer too, follows this phone`() {
        assertEquals(ThemeChoice.SYSTEM, ThemeChoice.from(null))
        assertEquals(ThemeChoice.SYSTEM, ThemeChoice.from("sepia"))
        assertEquals("a phone that matched its computer now matches itself", ThemeChoice.SYSTEM, ThemeChoice.from("computer"))
        assertEquals(ThemeChoice.DARK, ThemeChoice.from("dark"))
    }
}
