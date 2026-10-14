package com.nekko.android.ui.settings

import androidx.compose.runtime.Composable
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.ThemePrefs
import com.nekko.android.haptics.AndroidHaptics

/** What a Settings section can reach. New needs are new fields here, never new SettingsScreen parameters. */
class SettingsDeps(
    val repo: ComputersRepository,
    val themePrefs: ThemePrefs,
    val phonePrefs: PhonePrefs,
    /** The phone's vibrator, for Settings → Vibration's preview; null in previews and tests. */
    val haptics: AndroidHaptics? = null,
    /** Opens a route of the app's nav graph (see `Routes`). */
    val open: (route: String) -> Unit,
)

/** One block of the Settings screen, usually a [SettingsGroup] header and its card. */
typealias SettingsSection = @Composable (SettingsDeps) -> Unit

/**
 * The Settings screen, top to bottom. A new section is one file in this package and one line
 * here; keep About last.
 */
val SettingsSections: List<SettingsSection> = listOf(
    { AppearanceSection(it) },
    { SecuritySection(it) },
    { VibrationSection(it) },
    { ComputersSection(it) },
    { AboutSection(it) },
)
