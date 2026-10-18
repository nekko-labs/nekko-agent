package com.nekko.android.ui.settings

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

    SectionHeader("New chats")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SettingsRow(
                title = "Computer",
                detail = computerDetail(c, computerPref.ifEmpty { null }),
                icon = Icons.Filled.Computer,
                onClick = if (c.computers.size > 1) ({ dialog = "computer" }) else null,
            )
            if (active != null) {
                HorizontalDivider(color = p.line)
                SettingsRow(
                    title = "Model on ${active.name}",
                    detail = modelDetail(c, phonePick),
                    icon = Icons.Filled.Memory,
                    onClick = { dialog = "model" },
                )
            }
        }
        Text(
            "Saved on this phone. New chat opens with these; the computer’s own default model is not changed.",
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

private fun computerDetail(c: ComputersState, pref: String?): String {
    val chosen = c.computers.firstOrNull { it.id == pref }
    return when {
        c.computers.isEmpty() -> "None paired yet"
        chosen != null -> chosen.name
        c.computers.size == 1 -> c.computers.first().name
        else -> "The one used last"
    }
}

internal fun modelDetail(c: ComputersState, pick: ModelPick?): String {
    if (pick == null) return "Same as the computer’s default"
    val provider = c.providers.firstOrNull { it.id == pick.providerId }
    val name = c.models[pick.providerId]?.firstOrNull { it.id == pick.modelId }?.name ?: pick.modelId
    return if (provider != null) "$name · ${provider.label}" else name
}

@Composable
private fun ComputerDialog(c: ComputersState, pref: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Default computer") },
        text = {
            Column(Modifier.selectableGroup()) {
                Choice("The one used last", "Opens on whichever computer you used most recently", pref == null) { onPick(null) }
                c.computers.forEach { pc -> Choice(pc.name, null, pc.id == pref) { onPick(pc.id) } }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
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
        title = { Text("Default model on ${c.active?.name ?: "this computer"}") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()).selectableGroup()) {
                Choice("Same as the computer’s default", "Follows the default set in Nekko Agent on the computer", current == null) { onPick(null) }
                when {
                    !online -> Text("Connect to the computer to choose one of its models.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(8.dp))
                    groups.isEmpty() -> Text("No model providers are switched on on the computer.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(8.dp))
                    else -> groups.forEach { g ->
                        Text(
                            g.provider.label,
                            style = MaterialTheme.typography.labelMedium,
                            color = p.inkFaint,
                            modifier = Modifier.padding(top = 10.dp, bottom = 2.dp, start = 8.dp),
                        )
                        val list = g.models
                        when {
                            g.error != null -> Text("Couldn’t list its models.", style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.padding(start = 8.dp))
                            list == null -> Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                Text("Asking your computer…", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
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
                        "The saved model (${current.modelId}) isn’t offered by the computer any more; new chats use the computer’s default.",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.warning,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
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
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = p.accent, modifier = Modifier.size(18.dp))
    }
}
