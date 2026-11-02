package com.nekko.android.ui.screens

import androidx.annotation.StringRes
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.components.Dot
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.ago
import com.nekko.android.util.localAgo
import com.nekko.protocol.Pairing
import com.nekko.protocol.RelayState
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputersScreen(repo: ComputersRepository, onBack: () -> Unit, onPair: () -> Unit, onOpen: (String) -> Unit = {}) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var renaming by remember { mutableStateOf<Computer?>(null) }
    var forgetting by remember { mutableStateOf<Computer?>(null) }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_computers)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back)) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            Text(
                stringResource(R.string.settings_computers_intro),
                style = MaterialTheme.typography.bodyLarge,
                color = p.inkSoft,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            if (s.computers.isNotEmpty()) SectionHeader(stringResource(R.string.settings_paired))
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                s.computers.forEach { c ->
                    ComputerCard(
                        c = c,
                        s = s,
                        onUse = { scope.launch { repo.connect(c.id) } },
                        onPair = onPair,
                        onRename = { renaming = c },
                        onForget = { forgetting = c },
                        onOpen = { onOpen(c.id) },
                    )
                }
                Button(onClick = onPair, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 4.dp)) {
                    Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(if (s.computers.isEmpty()) stringResource(R.string.settings_pair_computer) else stringResource(R.string.settings_pair_another))
                }
            }
            SectionHeader(stringResource(R.string.settings_how_it_works))
            NCard(Modifier.padding(horizontal = 16.dp)) {
                Step(1, stringResource(R.string.settings_how_1))
                Step(2, stringResource(R.string.settings_how_2))
                Step(3, stringResource(R.string.settings_how_3))
                Step(4, stringResource(R.string.settings_how_4))
            }
            Spacer(Modifier.size(32.dp))
        }
    }

    renaming?.let { c ->
        var name by remember(c.id) { mutableStateOf(c.name) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text(stringResource(R.string.settings_rename_computer)) },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(40) },
                    singleLine = true,
                    label = { Text(stringResource(R.string.settings_name)) },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch { repo.rename(c.id, name) }
                        renaming = null
                    },
                    enabled = name.isNotBlank(),
                ) { Text(stringResource(R.string.settings_save)) }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }

    forgetting?.let { c ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text(stringResource(R.string.settings_forget_title, c.name)) },
            text = {
                Text(stringResource(R.string.settings_forget_text))
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { repo.forget(c.id) }
                    forgetting = null
                }) { Text(stringResource(R.string.settings_forget), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }
}

private enum class CardState(@StringRes val label: Int, val tone: Tone) {
    ONLINE(R.string.settings_state_online, Tone.SUCCESS),
    CONNECTING(R.string.settings_state_connecting_dots, Tone.WARNING),
    OFFLINE(R.string.settings_state_offline_short, Tone.WARNING),
    DENIED(R.string.settings_state_not_paired, Tone.DANGER),
    IDLE(R.string.settings_state_idle, Tone.FAINT),
}

@Composable
private fun ComputerCard(
    c: Computer,
    s: ComputersState,
    onUse: () -> Unit,
    onPair: () -> Unit,
    onRename: () -> Unit,
    onForget: () -> Unit,
    onOpen: () -> Unit,
) {
    val p = Nekko.palette
    val active = s.activeId == c.id
    val state = when {
        !active -> CardState.IDLE
        s.denied != null || s.conn == RelayState.DENIED -> CardState.DENIED
        s.conn == RelayState.ONLINE -> CardState.ONLINE
        s.conn == RelayState.OFFLINE -> CardState.OFFLINE
        s.conn == RelayState.CONNECTING -> CardState.CONNECTING
        else -> CardState.IDLE
    }
    var menu by remember { mutableStateOf(false) }
    NCard {
        // The name opens the computer's page (its details, models, hardware and round trip).
        Row(
            Modifier.clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button, onClickLabel = stringResource(R.string.settings_open_computer, c.name), onClick = onOpen).testTag("computer.open"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(p.accentSoft),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Computer, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(c.name, style = MaterialTheme.typography.titleMedium, color = p.ink)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Dot(state.tone)
                    Text(
                        ago(c.pairedAt).let {
                            if (it == "now") stringResource(R.string.settings_card_line_now, stringResource(state.label), Pairing.relayHost(c.relayUrl))
                            else stringResource(R.string.settings_card_line_ago, stringResource(state.label), Pairing.relayHost(c.relayUrl), localAgo(c.pairedAt))
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkSoft,
                    )
                }
            }
            if (active) Pill(stringResource(R.string.settings_active), Tone.ACCENT)
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
        }
        if (active && s.lastError != null && state == CardState.ONLINE) {
            Text(s.lastError, style = MaterialTheme.typography.bodySmall, color = p.danger)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                active && state == CardState.DENIED -> Button(onClick = onPair, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.settings_pair_again))
                }
                active -> OutlinedButton(onClick = onUse, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.settings_reconnect))
                }
                else -> Button(onClick = onUse, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.settings_use_this_computer))
                }
            }
            Box {
                IconButton(
                    onClick = { menu = true },
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(p.surface2),
                ) {
                    Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.settings_more_options_for, c.name), tint = p.inkSoft)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.settings_details)) },
                        leadingIcon = { Icon(Icons.Filled.Info, contentDescription = null) },
                        onClick = { menu = false; onOpen() },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.settings_rename)) },
                        leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                        onClick = { menu = false; onRename() },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.settings_forget_this_computer), color = p.danger) },
                        leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = p.danger) },
                        onClick = { menu = false; onForget() },
                    )
                }
            }
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    val p = Nekko.palette
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(p.accentSoft), contentAlignment = Alignment.Center) {
            Text("$n", style = MaterialTheme.typography.bodySmall, color = p.accent, fontWeight = FontWeight.Bold)
        }
        Text(text, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.weight(1f))
    }
}
