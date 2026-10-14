package com.nekko.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.protocol.Appearance

/** Settings → Appearance: what the phone's theme follows. */
@Composable
fun AppearanceSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val themePrefs = deps.themePrefs
    val choice by themePrefs.choice.collectAsStateWithLifecycle()
    val c by deps.repo.state.collectAsStateWithLifecycle()
    val computerName = c.active?.name ?: "your computer"

    SectionHeader("Appearance")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Column(Modifier.selectableGroup()) {
                ThemeChoice.entries.forEach { option ->
                    ChoiceRow(
                        title = option.label,
                        detail = detail(option, c.appearance, computerName),
                        swatch = if (option == ThemeChoice.COMPUTER) c.appearance?.accent else null,
                        selected = option == choice,
                        onClick = { themePrefs.set(option) },
                    )
                }
            }
        }
        Text(
            "Saved on this phone. With “Same as computer” the app follows ${computerName}’s theme and accent, and changes as soon as you change them there.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
}

private fun detail(option: ThemeChoice, computer: Appearance?, name: String): String? = when (option) {
    ThemeChoice.COMPUTER -> when (computer?.theme) {
        null -> "Waiting for $name; uses the phone setting meanwhile"
        Appearance.ThemeMode.DARK -> "$name is dark"
        Appearance.ThemeMode.LIGHT -> "$name is light"
        Appearance.ThemeMode.SYSTEM -> "$name follows its system; the phone uses its own"
    }
    ThemeChoice.SYSTEM -> "Light or dark, as the phone is set"
    else -> null
}

@Composable
private fun ChoiceRow(title: String, detail: String?, swatch: Long?, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        }
        if (swatch != null) {
            Box(Modifier.size(18.dp).clip(CircleShape).background(Color(swatch)).border(1.dp, p.line, CircleShape))
        }
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
        }
    }
}
