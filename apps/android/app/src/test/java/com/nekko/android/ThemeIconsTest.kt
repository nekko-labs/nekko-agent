package com.nekko.android

import com.nekko.android.ui.theme.DarkPalette
import com.nekko.android.ui.theme.LightPalette
import com.nekko.android.ui.theme.THEME_PRESETS
import com.nekko.android.ui.theme.ThemeIcons
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.android.ui.theme.contrast
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The theme list shows an icon for every theme, the desktop's nine as the desktop draws them, always readable. */
class ThemeIconsTest {
    @Test fun everyThemeHasAnIcon() {
        for (preset in THEME_PRESETS) assertNotNull("no icon for ${preset.id}", ThemeIcons.of(preset))
    }

    @Test fun theDesktopsNineKeepTheirIcons() {
        val find = { id: String -> ThemeIcons.of(ThemePreset.find(id)) }
        assertEquals(R.drawable.theme_cat, find("x-plum-white"))
        assertEquals(R.drawable.theme_cat, find("x-plum-dark"))
        assertEquals(R.drawable.theme_galaxy, find("nebula"))
        assertEquals(R.drawable.theme_terminal, find("terminal"))
        assertEquals(R.drawable.theme_mountain, find("nord"))
        assertEquals(R.drawable.theme_flame, find("ember"))
        assertEquals(R.drawable.theme_tree_evergreen, find("x-forest-colour"))
        assertEquals(R.drawable.theme_blueberry, find("x-blueberry-dark"))
        assertEquals(R.drawable.theme_wizard_hat, find("autumn"))
        assertEquals(R.drawable.theme_beanie, find("winter"))
    }

    @Test fun everyIconReadsOnBothPalettes() {
        for (p in listOf(LightPalette, DarkPalette)) for (preset in THEME_PRESETS) {
            val tint = ThemeIcons.tint(preset, null, p.surface, p.inkSoft)
            assertTrue("${preset.id} icon is ${contrast(tint, p.surface)}:1", contrast(tint, p.surface) >= 3f)
        }
    }

    @Test fun aPaleAccentDeepensOnALightPhoneAndKeepsItsHue() {
        val terminal = ThemeIcons.tint(ThemePreset.find("terminal"), null, LightPalette.surface, LightPalette.inkSoft)
        assertTrue("Terminal stays green", terminal.green > terminal.red && terminal.green > terminal.blue)
        val nebula = ThemeIcons.tint(ThemePreset.find("nebula"), null, LightPalette.surface, LightPalette.inkSoft)
        assertTrue("Nebula stays violet", nebula.blue > nebula.green && nebula.red > nebula.green)
        val forest = ThemeIcons.tint(ThemePreset.find("x-forest-white"), null, DarkPalette.surface, DarkPalette.inkSoft)
        assertTrue("Forest's deep green lightens on a dark phone", forest.green > forest.red && forest.green > forest.blue)
    }

    @Test fun aDarkThemesLightAccentFallsBackToItsPage() {
        val blueberryDark = ThemePreset.find("x-blueberry-dark")!!
        assertEquals(androidx.compose.ui.graphics.Color(blueberryDark.paper!!), ThemeIcons.tint(blueberryDark, null, LightPalette.surface, LightPalette.inkSoft))
        assertEquals(androidx.compose.ui.graphics.Color(blueberryDark.accent), ThemeIcons.tint(blueberryDark, null, DarkPalette.surface, DarkPalette.inkSoft))
    }
}
