package com.nekko.android.ui.theme

import androidx.annotation.DrawableRes
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import com.nekko.android.R

/**
 * Each theme's icon in the theme list, drawn like the desktop's picker
 * (theme-icons.tsx; the drawables come from scripts/phone-marks.mjs). The
 * desktop's nine keep their icons; the rows only the phones list (the mode
 * rows, the extra presets and the experimental families) have Gentleface ones
 * of their own. iOS keeps the same table in ThemeIcons.swift.
 */
object ThemeIcons {
    /** Match my computer. */
    @DrawableRes val computer: Int = R.drawable.theme_laptop

    val byId: Map<String, Int> = mapOf(
        "system" to R.drawable.theme_sun_moon,
        "light" to R.drawable.theme_sun,
        "dark" to R.drawable.theme_moon,
        "nebula" to R.drawable.theme_galaxy,
        "terminal" to R.drawable.theme_terminal,
        "nord" to R.drawable.theme_mountain,
        "solar" to R.drawable.theme_sunrise,
        "lilac" to R.drawable.theme_flower,
        "lavender" to R.drawable.theme_sprout,
        "nekko-dark" to R.drawable.theme_cat,
        "ember" to R.drawable.theme_flame,
        "autumn" to R.drawable.theme_wizard_hat,
        "winter" to R.drawable.theme_beanie,
    )

    /** Every version of a family shares its icon. */
    val byFamily: Map<String, Int> = mapOf(
        "Nekko" to R.drawable.theme_cat,
        "Forest" to R.drawable.theme_tree_evergreen,
        "Blueberry" to R.drawable.theme_blueberry,
        "Raspberry" to R.drawable.theme_cherry,
        "Mulberry" to R.drawable.theme_grape,
        "Cyber" to R.drawable.theme_cpu,
        "Quantum" to R.drawable.theme_atom,
        "Clay" to R.drawable.theme_amphora,
        "Inkberry" to R.drawable.theme_feather,
        "Neon" to R.drawable.theme_lightbulb,
        "Arctic Mist" to R.drawable.theme_snowflake,
        "Indigo" to R.drawable.theme_moon_star,
        "Obsidian" to R.drawable.theme_gem,
        "Orchid Pulse" to R.drawable.theme_potted_plant,
        "Indigo Parchment" to R.drawable.theme_scroll,
        "Tidepool" to R.drawable.theme_waves,
    )

    @DrawableRes
    fun of(preset: ThemePreset?): Int? = preset?.let { p -> p.family?.let(byFamily::get) ?: byId[p.id] }

    /**
     * The icon's colour: the theme's accent (or the computer's, for that row) when it
     * reads on [background] at 3:1. A pale accent on a light phone (or a deep one on a
     * dark phone) gives way to the theme's own page colour when that is a colour of its
     * own (Blueberry Dark's navy), else to the accent deepened toward black (or lightened
     * toward white) until it reads, keeping its hue as the desktop's light accents do.
     * Same rule as ThemeIcons.swift.
     */
    fun tint(preset: ThemePreset?, accent: Long?, background: Color, fallback: Color): Color {
        val a = (accent ?: preset?.accent)?.let { Color(it) } ?: return fallback
        if (contrast(a, background) >= 3f) return a
        preset?.paper?.let { Color(it) }?.takeIf { it.isChromatic() && contrast(it, background) >= 3f }?.let { return it }
        val toward = if (background.luminance() > 0.5f) Color.Black else Color.White
        return (1..10).map { mix(a, toward, it / 10f) }.firstOrNull { contrast(it, background) >= 3f } ?: fallback
    }

    /** A colour rather than a near-black or near-white: its channels spread at least 0x30. */
    private fun Color.isChromatic() = maxOf(red, green, blue) - minOf(red, green, blue) >= 0x30 / 255f

    /** Straight sRGB blend, as iOS does it. */
    private fun mix(a: Color, b: Color, f: Float) =
        Color(red = a.red + (b.red - a.red) * f, green = a.green + (b.green - a.green) * f, blue = a.blue + (b.blue - a.blue) * f)
}
