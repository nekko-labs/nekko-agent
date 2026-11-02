package com.nekko.android.ui.settings

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.android.ui.theme.ThemePreset
import com.nekko.protocol.Appearance

/**
 * Settings → Appearance (the iPhone's): the theme, picked from the desktop's
 * presets or following the computer, and the app's language, which Android's
 * per-app language setting chooses.
 */
@Composable
fun AppearanceSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val themePrefs = deps.themePrefs
    val choice by themePrefs.choice.collectAsStateWithLifecycle()
    val c by deps.repo.state.collectAsStateWithLifecycle()
    val computerName = c.active?.name ?: stringResource(R.string.your_computer)
    var picking by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val lock = LocalAppLock.current
    // The app's language, from the configuration so the row follows a change of language.
    val locale = LocalConfiguration.current.locales[0]

    SectionHeader(stringResource(R.string.appearance_title))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            LinkRow(
                stringResource(R.string.appearance_theme),
                themeName(choice),
                swatch = ThemePreset.find(if (choice == ThemeChoice.COMPUTER) c.appearance?.preset else choice.id),
                accent = if (choice == ThemeChoice.COMPUTER) c.appearance?.accent else null,
                tag = "settings.theme",
            ) { picking = true }
            HorizontalDivider(color = p.line)
            LinkRow(
                stringResource(R.string.appearance_language),
                locale.getDisplayLanguage(locale).replaceFirstChar { it.titlecase(locale) },
                tag = "settings.language",
            ) {
                // Android 13+ has a language for each app; earlier the app follows the phone's.
                val intent = if (Build.VERSION.SDK_INT >= 33) {
                    Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null))
                } else {
                    Intent(Settings.ACTION_LOCALE_SETTINGS)
                }
                lock?.expectReturn()
                try {
                    context.startActivity(intent)
                } catch (_: ActivityNotFoundException) {
                    context.startActivity(Intent(Settings.ACTION_SETTINGS))
                }
            }
        }
        Text(
            if (choice == ThemeChoice.COMPUTER) stringResource(R.string.appearance_footer_computer, computerName)
            else stringResource(R.string.appearance_footer),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
    if (picking) {
        ThemeDialog(choice, c.appearance, computerName, onDismiss = { picking = false }) { themePrefs.set(it); picking = false }
    }
}

/** A choice's name: Match my computer, Match this phone, Light, Dark, or the preset ("Blueberry · Dark"). */
@Composable
private fun themeName(choice: ThemeChoice): String = when (choice) {
    ThemeChoice.COMPUTER -> stringResource(R.string.appearance_match_computer)
    ThemeChoice.SYSTEM -> stringResource(R.string.appearance_match_phone)
    ThemeChoice.LIGHT -> stringResource(R.string.appearance_light)
    ThemeChoice.DARK -> stringResource(R.string.appearance_dark)
    else -> ThemePreset.find(choice.id)?.let { p -> p.family?.let { "$it · ${p.label}" } ?: p.label } ?: choice.id
}

@Composable
private fun LinkRow(title: String, value: String, swatch: ThemePreset? = null, accent: Long? = null, tag: String, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
        if (swatch != null || accent != null) Swatch(swatch, accent)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
    }
}

/** A preset's paper with its accent on it. */
@Composable
private fun Swatch(preset: ThemePreset?, accent: Long?) {
    val p = Nekko.palette
    val paper = preset?.paper?.let { Color(it) } ?: when (preset?.mode) {
        ThemePreset.Mode.DARK -> Color(0xFF0C0C11)
        ThemePreset.Mode.LIGHT -> Color(0xFFFBFBFD)
        else -> p.surface2
    }
    Box(Modifier.size(22.dp).clip(CircleShape).background(paper).border(1.dp, p.line, CircleShape), contentAlignment = Alignment.Center) {
        val a = accent ?: preset?.accent
        if (a != null) Box(Modifier.size(10.dp).clip(CircleShape).background(Color(a)))
    }
}

/** The desktop's themes: following the computer or this phone, Light, Dark, the named presets and the experimental families. */
@Composable
private fun ThemeDialog(choice: ThemeChoice, computer: Appearance?, computerName: String, onDismiss: () -> Unit, onPick: (ThemeChoice) -> Unit) {
    val p = Nekko.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.appearance_theme)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).selectableGroup()) {
                ChoiceRow(stringResource(R.string.appearance_match_computer), computerDetail(computer, computerName), ThemePreset.find(computer?.preset), computer?.accent, choice == ThemeChoice.COMPUTER, "theme.computer") { onPick(ThemeChoice.COMPUTER) }
                ChoiceRow(stringResource(R.string.appearance_match_phone), stringResource(R.string.appearance_match_phone_detail), ThemePreset.find("system"), null, choice == ThemeChoice.SYSTEM, "theme.system") { onPick(ThemeChoice.SYSTEM) }
                ChoiceRow(stringResource(R.string.appearance_light), null, ThemePreset.find("light"), null, choice == ThemeChoice.LIGHT, "theme.light") { onPick(ThemeChoice.LIGHT) }
                ChoiceRow(stringResource(R.string.appearance_dark), null, ThemePreset.find("dark"), null, choice == ThemeChoice.DARK, "theme.dark") { onPick(ThemeChoice.DARK) }
                Heading(stringResource(R.string.appearance_presets))
                ThemePreset.named.forEach { t -> ChoiceRow(t.label, null, t, null, choice.id == t.id, "theme.${t.id}") { onPick(ThemeChoice(t.id)) } }
                Heading(stringResource(R.string.appearance_experimental))
                ThemePreset.families.forEach { (family, versions) ->
                    Text(family, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.padding(start = 12.dp, top = 8.dp))
                    versions.forEach { t -> ChoiceRow(t.label, null, t, null, choice.id == t.id, "theme.${t.id}", description = "$family · ${t.label}") { onPick(ThemeChoice(t.id)) } }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.appearance_done)) } },
    )
}

@Composable
private fun Heading(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = Nekko.palette.inkFaint,
        modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun computerDetail(computer: Appearance?, name: String): String = when (computer?.theme) {
    null -> stringResource(R.string.appearance_computer_waiting, name)
    Appearance.ThemeMode.DARK -> stringResource(R.string.appearance_computer_dark, name)
    Appearance.ThemeMode.LIGHT -> stringResource(R.string.appearance_computer_light, name)
    Appearance.ThemeMode.SYSTEM -> stringResource(R.string.appearance_computer_system, name)
}

@Composable
private fun ChoiceRow(
    title: String,
    detail: String?,
    preset: ThemePreset?,
    accent: Long?,
    selected: Boolean,
    tag: String,
    description: String? = null,
    onClick: () -> Unit,
) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag(tag)
            .semantics(mergeDescendants = true) { if (description != null) contentDescription = description },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Swatch(preset, accent)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        }
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
        }
    }
}
