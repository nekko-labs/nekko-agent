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
    /** This phone's own providers (Settings → Models on This phone, #2940); null in previews and tests. */
    val phone: com.nekko.android.phone.PhoneChats? = null,
)

/** One block of the Settings screen, usually a [SettingsGroup] header and its card. */
typealias SettingsSection = @Composable (SettingsDeps) -> Unit

/**
 * The Settings screen, top to bottom. A new section is one file in this package and one line
 * here; keep About last.
 */
val SettingsSections: List<SettingsSection> = listOf(
    // Computers first, then this phone's providers (#2940, the iPhone's #2929). The Nekko Cloud
    // profile goes above them once Android signs in to Nekko Cloud (#2835).
    { ComputersSection(it) },
    { PhoneModelsSection(it) },
    { AppearanceSection(it) },
    { SimpleModeSection(it) },
    { SecuritySection(it) },
    { com.nekko.android.permissions.DeviceAccessSection(it) },
    { NewChatsSection(it) },
    { ConnectorsSection(it) },
    { ConnectionSection(it) },
    { ConnectionStatusSection(it) },
    { VibrationSection(it) },
    { DictationSection(it) },
    { PcSettingsSection(it) },
    { AutomationsUsageSection(it) },
    { ThisComputerSection(it) },
    { FeedbackSection(it) },
    { AboutSection(it) },
)
