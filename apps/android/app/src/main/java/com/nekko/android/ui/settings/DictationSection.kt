package com.nekko.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.nekko.android.voice.ComputerVoice
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.EngineChoice
import com.nekko.protocol.RelayState

/**
 * Settings → Dictation: the composer's microphone, and where speech becomes
 * text. Saved on this phone; the computer's Nekko Voice settings are its own.
 */
@Composable
fun DictationSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val prefs = deps.phonePrefs
    val on by prefs.flow(Dictation.ENABLED).collectAsStateWithLifecycle()
    val choice by prefs.flow(Dictation.ENGINE).collectAsStateWithLifecycle()
    val language by prefs.flow(Dictation.LANGUAGE).collectAsStateWithLifecycle()
    val c by deps.repo.state.collectAsStateWithLifecycle()
    val name = c.active?.name ?: "your computer"
    val online = c.conn == RelayState.ONLINE

    // Whether the computer's Whisper is ready, asked when this screen shows.
    var pc by remember { mutableStateOf<ComputerVoice?>(null) }
    LaunchedEffect(online, c.pcSettings.voiceEnabled, c.activeId) {
        pc = if (c.active == null) null else runCatching {
            DictationController.computerVoice(deps.repo.caller, online, c.pcSettings.voiceEnabled)
        }.getOrNull()
    }

    SectionHeader("Dictation")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Row(
                Modifier.fillMaxWidth()
                    .toggleable(value = on, role = Role.Switch) { prefs.set(Dictation.ENABLED, it) }
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Microphone in chats", style = MaterialTheme.typography.bodyLarge, color = p.ink)
                    Text("Speak a message; it goes in the box and you press Send", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                }
                Switch(checked = on, onCheckedChange = null)
            }
            if (on) {
                HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 4.dp))
                Text("Turn speech into text with", style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.padding(start = 12.dp, top = 6.dp))
                Column(Modifier.selectableGroup()) {
                    EngineRow(
                        "$name when ready",
                        "Nekko Voice (Whisper) on $name, end-to-end encrypted. Otherwise this phone.",
                        choice == EngineChoice.COMPUTER_FIRST,
                    ) { prefs.set(Dictation.ENGINE, EngineChoice.COMPUTER_FIRST) }
                    EngineRow(
                        "$name only",
                        "The audio only ever goes to $name. Up to 30 seconds at a time.",
                        choice == EngineChoice.COMPUTER_ONLY,
                    ) { prefs.set(Dictation.ENGINE, EngineChoice.COMPUTER_ONLY) }
                    EngineRow(
                        "This phone",
                        "Android’s speech recognizer. Depending on the phone, the audio may go to Google.",
                        choice == EngineChoice.PHONE,
                    ) { prefs.set(Dictation.ENGINE, EngineChoice.PHONE) }
                }
                if (choice == EngineChoice.PHONE || choice == EngineChoice.COMPUTER_FIRST) {
                    OutlinedTextField(
                        value = language,
                        onValueChange = { prefs.set(Dictation.LANGUAGE, it.trim().take(16)) },
                        singleLine = true,
                        label = { Text("Phone recognizer language") },
                        placeholder = { Text("The phone’s own, or e.g. it-IT") },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        }
        if (on && choice != EngineChoice.PHONE) {
            val status = when {
                c.active == null -> null
                pc == null -> "Checking Nekko Voice on $name…"
                pc!!.ready -> "Nekko Voice is ready on $name."
                else -> pc!!.whyNot(name) + if (choice == EngineChoice.COMPUTER_FIRST) " This phone’s recognizer is used meanwhile." else ""
            }
            status?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (pc?.ready == true) p.success else p.warning,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
                )
            }
        }
        Text(
            "Saved on this phone. Nothing is recorded until you tap the microphone, the audio is kept in memory only, and dictated text is never sent without you pressing Send. $name uses the language set in its own Nekko Voice settings.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun EngineRow(title: String, detail: String, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = p.accent, modifier = Modifier.size(20.dp))
    }
}
