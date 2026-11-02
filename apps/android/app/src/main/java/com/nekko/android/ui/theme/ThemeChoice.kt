package com.nekko.android.ui.theme

import com.nekko.protocol.Appearance

/**
 * A desktop theme preset (`ThemePreset`, packages/shared/src/themes.ts); the
 * catalog is [THEME_PRESETS] in ThemePresets.kt, written from the desktop's.
 */
data class ThemePreset(
    val id: String,
    val label: String,
    val mode: Mode,
    val accent: Long,
    val accent2: Long,
    /** The experimental family this is a version of; [label] then names the version. */
    val family: String?,
    val paper: Long?,
    val surface: Long?,
    val surface2: Long?,
    val ink: Long?,
    val inkSoft: Long?,
    val inkFaint: Long?,
    val line: Long?,
) {
    enum class Mode { SYSTEM, LIGHT, DARK }

    /** System, Light and Dark keep the phone's own palette (its accents are tuned for contrast). */
    val isBasic: Boolean get() = id in BASIC

    companion object {
        private val BASIC = setOf("system", "light", "dark")

        fun find(id: String?): ThemePreset? = THEME_PRESETS.firstOrNull { it.id == id }

        /** The named presets (Nebula, Nord…), in the desktop's order. */
        val named: List<ThemePreset> get() = THEME_PRESETS.filter { it.family == null && !it.isBasic }

        /** The experimental families, each with its versions (White, Colourful, Dark). */
        val families: List<Pair<String, List<ThemePreset>>>
            get() = THEME_PRESETS.mapNotNull { it.family }.distinct().map { f -> f to THEME_PRESETS.filter { it.family == f } }
    }
}

/**
 * What the phone's theme follows, stored on the phone only (Settings →
 * Appearance → Theme): the computer's look ([COMPUTER], the default) or a
 * desktop preset id ([SYSTEM] follows the phone). The iPhone's choice.
 */
@JvmInline
value class ThemeChoice(val id: String) {
    companion object {
        /** The paired computer's preset, light/dark mode and accent, live. */
        val COMPUTER = ThemeChoice("computer")
        val SYSTEM = ThemeChoice("system")
        val LIGHT = ThemeChoice("light")
        val DARK = ThemeChoice("dark")

        /** A stored id this phone doesn't know reads as [COMPUTER]. */
        fun from(id: String?): ThemeChoice = if (id != null && ThemePreset.find(id) != null) ThemeChoice(id) else COMPUTER
    }
}

/** The look to draw: light or dark, the accent (null keeps the palette's own), and a preset's surfaces. */
data class ResolvedTheme(val dark: Boolean, val accent: Long?, val preset: ThemePreset? = null)

object ThemeResolver {
    /**
     * [systemDark] is the phone's own setting. "Match my computer" uses the
     * computer's preset, mode and accent; a computer set to System, or one that
     * has not answered yet (offline, nothing paired), falls back to the phone's
     * setting. A preset brings its own mode (System follows the phone) and, unless
     * it is System, Light or Dark, its accent and surfaces.
     */
    fun resolve(choice: ThemeChoice, computer: Appearance?, systemDark: Boolean): ResolvedTheme {
        if (choice == ThemeChoice.COMPUTER) {
            return ResolvedTheme(
                dark = when (computer?.theme) {
                    Appearance.ThemeMode.LIGHT -> false
                    Appearance.ThemeMode.DARK -> true
                    else -> systemDark
                },
                accent = computer?.accent,
                preset = ThemePreset.find(computer?.preset),
            )
        }
        val preset = ThemePreset.find(choice.id)
        val dark = when (preset?.mode) {
            ThemePreset.Mode.LIGHT -> false
            ThemePreset.Mode.DARK -> true
            else -> systemDark
        }
        return ResolvedTheme(dark, null, preset)
    }
}
