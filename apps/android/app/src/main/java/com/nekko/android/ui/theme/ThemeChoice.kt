package com.nekko.android.ui.theme

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

        /** The violet System, Light and Dark shipped before the plum palette; desktops still save them. */
        val RETIRED_BASIC_ACCENTS = setOf(0xFF6D5EFCL, 0xFF8B7DFFL)

        fun find(id: String?): ThemePreset? = THEME_PRESETS.firstOrNull { it.id == id }

        /** The named presets (Nebula, Nord…), in the desktop's order. */
        val named: List<ThemePreset> get() = THEME_PRESETS.filter { it.family == null && !it.isBasic }

        /** The experimental families, each with its versions (White, Colourful, Dark). */
        val families: List<Pair<String, List<ThemePreset>>>
            get() = THEME_PRESETS.mapNotNull { it.family }.distinct().map { f -> f to THEME_PRESETS.filter { it.family == f } }
    }
}

/**
 * The phone's theme, stored on the phone only (Settings → Appearance → Theme): a desktop preset id,
 * [SYSTEM] (the default) following the phone's light or dark setting. The phone no longer follows the
 * computer's own theme: the desktop's look didn't fit the phone.
 */
@JvmInline
value class ThemeChoice(val id: String) {
    companion object {
        val SYSTEM = ThemeChoice("system")
        val LIGHT = ThemeChoice("light")
        val DARK = ThemeChoice("dark")

        /** A stored id this phone doesn't know (the retired "computer" among them) reads as [SYSTEM]. */
        fun from(id: String?): ThemeChoice = if (id != null && ThemePreset.find(id) != null) ThemeChoice(id) else SYSTEM
    }
}

/** The look to draw: light or dark, the accent (null keeps the palette's own), and a preset's surfaces. */
data class ResolvedTheme(val dark: Boolean, val accent: Long?, val preset: ThemePreset? = null)

object ThemeResolver {
    /**
     * [systemDark] is the phone's own setting. A preset brings its own mode (System follows the phone)
     * and, unless it is System, Light or Dark, its accent and surfaces.
     */
    fun resolve(choice: ThemeChoice, systemDark: Boolean): ResolvedTheme {
        val preset = ThemePreset.find(choice.id)
        val dark = when (preset?.mode) {
            ThemePreset.Mode.LIGHT -> false
            ThemePreset.Mode.DARK -> true
            else -> systemDark
        }
        return ResolvedTheme(dark, null, preset)
    }
}
