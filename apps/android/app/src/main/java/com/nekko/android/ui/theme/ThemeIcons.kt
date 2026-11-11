package com.nekko.android.ui.theme

import androidx.annotation.DrawableRes
import androidx.compose.ui.graphics.Color
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
     * The icon's colour: the theme's accent (or the computer's, for that row)
     * when it reads on [background] at 3:1, else the theme's own page colour
     * when that does (a dark theme's light accent on a light phone), else [fallback].
     */
    fun tint(preset: ThemePreset?, accent: Long?, background: Color, fallback: Color): Color =
        listOfNotNull(accent ?: preset?.accent, preset?.paper)
            .map { Color(it) }
            .firstOrNull { contrast(it, background) >= 3f } ?: fallback
}
