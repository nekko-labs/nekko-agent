package com.nekko.android.ui.theme

import com.nekko.protocol.Appearance

/** What the phone's theme follows. Stored on the phone only (Settings → Appearance). */
enum class ThemeChoice(val id: String, val label: String) {
    /** The paired computer's theme and accent, live (the default). */
    COMPUTER("computer", "Same as computer"),
    SYSTEM("system", "Phone setting"),
    LIGHT("light", "Light"),
    DARK("dark", "Dark"),
    ;

    companion object {
        fun from(id: String?): ThemeChoice = entries.firstOrNull { it.id == id } ?: COMPUTER
    }
}

/** The look to draw: light or dark, and the accent to use (null keeps the palette's own). */
data class ResolvedTheme(val dark: Boolean, val accent: Long?)

object ThemeResolver {
    /**
     * [systemDark] is the phone's own setting. "Same as computer" uses the
     * computer's mode and accent; a computer set to System, or one that has
     * not answered yet (offline, nothing paired), falls back to the phone's
     * setting. The other choices ignore the computer entirely, accent included.
     */
    fun resolve(choice: ThemeChoice, computer: Appearance?, systemDark: Boolean): ResolvedTheme = when (choice) {
        ThemeChoice.SYSTEM -> ResolvedTheme(systemDark, null)
        ThemeChoice.LIGHT -> ResolvedTheme(false, null)
        ThemeChoice.DARK -> ResolvedTheme(true, null)
        ThemeChoice.COMPUTER -> ResolvedTheme(
            dark = when (computer?.theme) {
                Appearance.ThemeMode.LIGHT -> false
                Appearance.ThemeMode.DARK -> true
                else -> systemDark
            },
            accent = computer?.accent,
        )
    }
}
