package com.nekko.android

import com.nekko.android.ui.theme.ThemeChoice
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
