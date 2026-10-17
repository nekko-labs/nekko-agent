package com.nekko.android

import androidx.compose.ui.graphics.Color
import com.nekko.android.ui.theme.DarkPalette
import com.nekko.android.ui.theme.LightPalette
import com.nekko.android.ui.theme.Palette
import com.nekko.android.ui.theme.contrast
import com.nekko.android.ui.theme.withAccent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** WCAG AA (4.5:1) for every text colour on every surface it sits on, as on iOS. */
class PaletteContrastTest {
    private fun Palette.texts() = mapOf(
        "ink" to ink, "inkSoft" to inkSoft, "inkFaint" to inkFaint, "accent" to accent,
        "success" to success, "danger" to danger, "warning" to warning, "running" to running,
    )

    private fun Palette.surfaces() = mapOf("paper" to paper, "surface" to surface, "surface2" to surface2)

    @Test fun contrastIsTheWcagRatio() {
        assertEquals(21f, contrast(Color.White, Color.Black), 0.01f)
        assertEquals(1f, contrast(Color.White, Color.White), 0.001f)
    }

    @Test fun textColoursMeetAaInBothThemes() {
        for ((theme, p) in listOf("light" to LightPalette, "dark" to DarkPalette)) {
            for ((t, fg) in p.texts()) for ((s, bg) in p.surfaces()) {
                val r = contrast(fg, bg)
                assertTrue("$theme $t on $s is $r", r >= 4.5f)
            }
            assertTrue("$theme text on accent", contrast(p.accentInk, p.accent) >= 4.5f)
            assertTrue("$theme text on the user's bubble", contrast(p.userInk, p.userBubble) >= 4.5f)
        }
    }

    @Test fun theComputersAccentGetsWhicheverInkReadsBetter() {
        val dark = LightPalette.withAccent(0xFF8B7DFF, dark = false)
        assertEquals(Color(0xFF0C0C11), dark.accentInk)
        val white = LightPalette.withAccent(0xFF3A2FB0, dark = false)
        assertEquals(Color.White, white.accentInk)
    }
}
