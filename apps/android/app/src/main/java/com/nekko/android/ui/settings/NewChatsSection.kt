package com.nekko.android.ui.settings

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersState
import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelPick
import com.nekko.android.data.NewChatDefaults
import com.nekko.android.data.modelGroups
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayState
import kotlinx.coroutines.CancellationException

/**
 * Settings → New chats: the phone's own defaults for chats started here. Stored
 * on the phone; the computer's default model is not changed.
 */
@Composable
fun NewChatsSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val defaults = remember(deps.phonePrefs) { NewChatDefaults(deps.phonePrefs) }
    val c by deps.repo.state.collectAsStateWithLifecycle()
    // Redraw when either value changes.
    val computerPref by defaults.computerFlow.collectAsStateWithLifecycle()
    val modelsPref by defaults.modelsFlow.collectAsStateWithLifecycle()
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }

    val active = c.active
    val phonePick = remember(modelsPref, active?.id) { active?.let { defaults.model(it.id) } }

    SectionHeader(stringResource(R.string.settings_new_chats))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.settings_fact_computer),
                detail = computerDetail(c, computerPref.ifEmpty { null }),
                icon = Icons.Filled.Computer,
                onClick = if (c.computers.size > 1) ({ dialog = "computer" }) else null,
            )
            if (active != null) {
                HorizontalDivider(color = p.line)
                SettingsRow(
                    title = stringResource(R.string.settings_model_on, active.name),
                    detail = modelDetail(c, phonePick),
                    icon = Icons.Filled.Memory,
                    onClick = { dialog = "model" },
                )
            }
        }
        Text(
            stringResource(R.string.settings_new_chats_footer),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }

    when (dialog) {
        "computer" -> ComputerDialog(c, computerPref.ifEmpty { null }, onPick = { defaults.setComputer(it); dialog = null }, onDismiss = { dialog = null })
        "model" -> if (active != null) {
            ModelDialog(deps, c, phonePick, onPick = { defaults.setModel(active.id, it); dialog = null }, onDismiss = { dialog = null })
        }
    }
}

@Composable
private fun computerDetail(c: ComputersState, pref: String?): String {
    val chosen = c.computers.firstOrNull { it.id == pref }
    return when {
        c.computers.isEmpty() -> stringResource(R.string.settings_computers_none)
        chosen != null -> chosen.name
        c.computers.size == 1 -> c.computers.first().name
        else -> stringResource(R.string.settings_used_last)
    }
}

@Composable
internal fun modelDetail(c: ComputersState, pick: ModelPick?): String {
    if (pick == null) return stringResource(R.string.settings_same_as_default)
    val provider = c.providers.firstOrNull { it.id == pick.providerId }
    val name = c.models[pick.providerId]?.firstOrNull { it.id == pick.modelId }?.name ?: pick.modelId
    return if (provider != null) "$name · ${provider.label}" else name
}

@Composable
private fun ComputerDialog(c: ComputersState, pref: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_default_computer)) },
        text = {
            Column(Modifier.selectableGroup()) {
                Choice(stringResource(R.string.settings_used_last), stringResource(R.string.settings_used_last_detail), pref == null) { onPick(null) }
                c.computers.forEach { pc -> Choice(pc.name, null, pc.id == pref) { onPick(pc.id) } }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_close)) } },
    )
}

@Composable
private fun ModelDialog(deps: SettingsDeps, c: ComputersState, current: ModelPick?, onPick: (ModelPick?) -> Unit, onDismiss: () -> Unit) {
    val p = Nekko.palette
    val online = c.conn == RelayState.ONLINE
    val groups = modelGroups(c)
    LaunchedEffect(online, c.providers) {
        if (online && c.providers.isNotEmpty()) {
            try {
                deps.repo.loadAllModels()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Per-provider failures show in the list.
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_default_model_on, c.active?.name ?: stringResource(R.string.settings_this_computer_lower))) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()).selectableGroup()) {
                Choice(stringResource(R.string.settings_same_as_default), stringResource(R.string.settings_same_as_default_detail), current == null) { onPick(null) }
                when {
                    !online -> Text(stringResource(R.string.settings_connect_to_choose), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(8.dp))
                    groups.isEmpty() -> Text(stringResource(R.string.settings_no_providers_on), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(8.dp))
                    else -> groups.forEach { g ->
                        Text(
                            g.provider.label,
                            style = MaterialTheme.typography.labelMedium,
                            color = p.inkFaint,
                            modifier = Modifier.padding(top = 10.dp, bottom = 2.dp, start = 8.dp),
                        )
                        val list = g.models
                        when {
                            g.error != null -> Text(stringResource(R.string.settings_couldnt_list), style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.padding(start = 8.dp))
                            list == null -> Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                Text(stringResource(R.string.settings_asking_computer), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                            }
                            else -> list.forEach { m ->
                                val k = ModelPick(g.provider.id, m.id)
                                Choice(m.name, null, k == current) { onPick(k) }
                            }
                        }
                    }
                }
                if (current != null && ModelChoice.phonePickMissing(current, groups)) {
                    Text(
                        stringResource(R.string.settings_saved_model_missing, current.modelId),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.warning,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_close)) } },
    )
}

@Composable
private fun Choice(title: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else Color.Transparent)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.settings_selected), tint = p.accent, modifier = Modifier.size(18.dp))
    }
}
