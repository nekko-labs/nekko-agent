package com.nekko.android.ui.settings

import android.content.res.Resources
import androidx.compose.ui.platform.LocalResources
import androidx.annotation.StringRes
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.security.PendingStepUp
import com.nekko.android.ui.security.StepUpSheet
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PcSettings
import com.nekko.protocol.RelayException
import com.nekko.protocol.PcSettings.ChatAction
import com.nekko.protocol.PcSettings.ChatMode
import com.nekko.protocol.RelayState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Settings → On <computer>: the computer's own settings that a paired phone may
 * change (the computer refuses any other key). Changes are saved on the
 * computer and show in its Settings too. Read-only while offline.
 */
@Composable
fun PcSettingsSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    val c by deps.repo.state.collectAsStateWithLifecycle()
    val active = c.active ?: return
    val online = c.conn == RelayState.ONLINE
    val pc = c.pcSettings
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var askYolo by rememberSaveable { mutableStateOf(false) }
    // A mode raise the computer wants a second factor for (SK-7): the sheet asks, then sends it again.
    var stepUp by remember { mutableStateOf<PendingStepUp?>(null) }

    val save: (JsonObject) -> Unit = { patch ->
        error = null
        busy = true
        scope.launch {
            try {
                deps.repo.updatePcSettings(patch)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // pcSettings only changes on the computer's reply, so a refused change (raising the
                // mode needs a confirmation this phone can't sign yet) leaves the old choice selected.
                // The repository's remote has already reworded refusals into what to do.
                if ((e as? RelayException)?.refusal?.asksForStepUp == true) {
                    stepUp = PendingStepUp(stepUpAction(patch, active.name, res)) { proof -> deps.repo.updatePcSettings(patch, proof) }
                } else {
                    error = e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.settings_didnt_save, active.name)
                }
            } finally {
                busy = false
            }
        }
    }
    stepUp?.let { pending ->
        StepUpSheet(deps.repo, pending, onDone = { stepUp = null }, onDismiss = { stepUp = null })
    }
    // Never show the computer's settings before it has told us what they are:
    // defaults drawn as if they were its values would be wrong (YOLO shown as Guardrails).
    val enabled = online && !busy && pc.known

    if (!pc.known) {
        SectionHeader(stringResource(R.string.settings_on_computer, active.name))
        Column(Modifier.padding(horizontal = 16.dp)) {
            Text(
                if (online) stringResource(R.string.settings_reading_settings, active.name)
                else stringResource(R.string.settings_pc_offline_unknown, active.name),
                style = MaterialTheme.typography.bodySmall,
                color = p.inkFaint,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
            )
        }
        return
    }

    SectionHeader(stringResource(R.string.settings_on_computer, active.name))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Text(stringResource(R.string.settings_chat_mode_new), style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.padding(start = 12.dp, top = 6.dp))
            Column(Modifier.selectableGroup()) {
                ChatMode.entries.forEach { m ->
                    Choice(
                        title = stringResource(modeTitleRes(m)),
                        detail = stringResource(modeDetailRes(m)),
                        selected = pc.effectiveMode == m,
                        enabled = enabled,
                        danger = m == ChatMode.YOLO,
                    ) {
                        // YOLO runs everything without asking: say so once before switching.
                        if (m == ChatMode.YOLO && pc.effectiveMode != ChatMode.YOLO) askYolo = true
                        else if (m != pc.effectiveMode) save(PcSettings.patch(mode = m))
                    }
                }
            }
            HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 4.dp))
            Text(stringResource(R.string.settings_long_press), style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.padding(start = 12.dp, top = 6.dp))
            Column(Modifier.selectableGroup()) {
                Choice(stringResource(R.string.settings_complete_it), stringResource(R.string.settings_complete_it_detail, active.name), pc.effectiveAction == ChatAction.COMPLETE, enabled) {
                    if (pc.effectiveAction != ChatAction.COMPLETE) save(PcSettings.patch(action = ChatAction.COMPLETE))
                }
                Choice(stringResource(R.string.settings_delete_it), stringResource(R.string.settings_delete_it_detail, active.name), pc.effectiveAction == ChatAction.DELETE, enabled) {
                    if (pc.effectiveAction != ChatAction.DELETE) save(PcSettings.patch(action = ChatAction.DELETE))
                }
            }
            HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 4.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .toggleable(value = pc.confirmDelete, enabled = enabled, role = Role.Switch) { want -> save(PcSettings.patch(skipConfirm = !want)) }
                    .heightIn(min = 56.dp)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.settings_confirm_delete), style = MaterialTheme.typography.bodyLarge, color = p.ink)
                    Text(stringResource(R.string.settings_confirm_delete_detail, active.name), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                }
                Switch(checked = pc.confirmDelete, onCheckedChange = null, enabled = enabled)
            }
        }
        error?.let { Notice(it, Tone.DANGER, Modifier.padding(top = 10.dp)) }
        Text(
            if (online) stringResource(R.string.settings_pc_footer_online, active.name)
            else stringResource(R.string.settings_pc_footer_offline, active.name),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }

    if (askYolo) {
        AlertDialog(
            onDismissRequest = { askYolo = false },
            title = { Text(stringResource(R.string.settings_yolo_title)) },
            text = {
                Text(stringResource(R.string.settings_yolo_text, active.name))
            },
            confirmButton = {
                TextButton(onClick = {
                    askYolo = false
                    save(PcSettings.patch(mode = ChatMode.YOLO))
                }) { Text(stringResource(R.string.settings_use_yolo), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { askYolo = false }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }
}

/** What the step-up sheet says the change is (*Switch new chats on Studio to YOLO*), in the phone's language. */
internal fun stepUpAction(patch: JsonObject, computer: String, res: Resources): String {
    val mode = ChatMode.of((patch["defaultChatMode"] as? JsonPrimitive)?.contentOrNull)
    return if (mode != null) res.getString(R.string.settings_step_up_switch, computer, res.getString(modeTitleRes(mode)))
    else res.getString(R.string.settings_step_up_change, computer)
}

/** The same in English, as the JVM tests read it. */
internal fun stepUpAction(patch: JsonObject, computer: String): String {
    val mode = ChatMode.of((patch["defaultChatMode"] as? JsonPrimitive)?.contentOrNull)
    return if (mode != null) "Switch new chats on $computer to ${modeTitle(mode)}" else "Change $computer’s settings"
}

@StringRes
internal fun modeTitleRes(m: ChatMode) = when (m) {
    ChatMode.ASK -> R.string.settings_mode_ask
    ChatMode.GUARDRAILS -> R.string.settings_mode_guardrails
    ChatMode.YOLO -> R.string.settings_mode_yolo
}

/** [modeDetail] as a string resource. */
@StringRes
internal fun modeDetailRes(m: ChatMode) = when (m) {
    ChatMode.ASK -> R.string.settings_mode_ask_detail
    ChatMode.GUARDRAILS -> R.string.settings_mode_guardrails_detail
    ChatMode.YOLO -> R.string.settings_mode_yolo_detail
}

/** English; on screen use [modeTitleRes]. */
internal fun modeTitle(m: ChatMode) = when (m) {
    ChatMode.ASK -> "Ask"
    ChatMode.GUARDRAILS -> "Guardrails"
    ChatMode.YOLO -> "YOLO"
}

/** The desktop's own descriptions (SettingsView CHAT_MODES). */
internal fun modeDetail(m: ChatMode) = when (m) {
    ChatMode.ASK -> "Confirm every file write and command before it runs"
    ChatMode.GUARDRAILS -> "Run freely, but ask or deny per your guardrail rules"
    ChatMode.YOLO -> "Run everything without confirming; deny rules still block"
}

@Composable
private fun Choice(title: String, detail: String, selected: Boolean, enabled: Boolean, danger: Boolean = false, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (danger) p.danger else p.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.settings_selected), tint = p.accent, modifier = Modifier.size(20.dp))
    }
}
