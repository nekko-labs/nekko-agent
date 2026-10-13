package com.nekko.android.ui.screens

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
import com.nekko.protocol.Pairing
import com.nekko.protocol.RelayState
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputersScreen(repo: ComputersRepository, onBack: () -> Unit, onPair: () -> Unit) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var renaming by remember { mutableStateOf<Computer?>(null) }
    var forgetting by remember { mutableStateOf<Computer?>(null) }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Computers") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            Text(
                "Run Nekko Agent on your computer and steer it from here: start chats, follow runs, approve what it wants to do.",
                style = MaterialTheme.typography.bodyLarge,
                color = p.inkSoft,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            if (s.computers.isNotEmpty()) SectionHeader("Paired")
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                s.computers.forEach { c ->
                    ComputerCard(
                        c = c,
                        s = s,
                        onUse = { scope.launch { repo.connect(c.id) } },
                        onPair = onPair,
                        onRename = { renaming = c },
                        onForget = { forgetting = c },
                    )
                }
                Button(onClick = onPair, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 4.dp)) {
                    Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(if (s.computers.isEmpty()) "Pair a computer" else "Pair another computer")
                }
            }
            SectionHeader("How it works")
            NCard(Modifier.padding(horizontal = 16.dp)) {
                Step(1, "On your computer, open Nekko Agent → Settings → Remote access and turn it on.")
                Step(2, "Choose “Pair a device” and scan the QR with this app. The code works once and expires in 10 minutes.")
                Step(3, "Your computer dials out to a relay; it never opens a port. Everything is end-to-end encrypted with a key only your devices hold.")
                Step(4, "Remove this phone any time from the same screen on your computer. It loses access immediately.")
            }
            Spacer(Modifier.size(32.dp))
        }
    }

    renaming?.let { c ->
        var name by remember(c.id) { mutableStateOf(c.name) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename computer") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(40) },
                    singleLine = true,
                    label = { Text("Name") },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch { repo.rename(c.id, name) }
                        renaming = null
                    },
                    enabled = name.isNotBlank(),
                ) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
        )
    }

    forgetting?.let { c ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("Forget ${c.name}?") },
            text = {
                Text("This phone deletes the pairing key. To be safe, also remove the phone on your computer (Settings → Remote access).")
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch { repo.forget(c.id) }
                    forgetting = null
                }) { Text("Forget", color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Cancel") } },
        )
    }
}

private enum class CardState(val label: String, val tone: Tone) {
    ONLINE("Online", Tone.SUCCESS),
    CONNECTING("Connecting…", Tone.WARNING),
    OFFLINE("Offline", Tone.WARNING),
    DENIED("Not paired", Tone.DANGER),
    IDLE("Not connected", Tone.FAINT),
}

@Composable
private fun ComputerCard(
    c: Computer,
    s: ComputersState,
    onUse: () -> Unit,
    onPair: () -> Unit,
    onRename: () -> Unit,
    onForget: () -> Unit,
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
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
                        "${state.label} · ${Pairing.relayHost(c.relayUrl)} · paired ${ago(c.pairedAt)} ago",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkSoft,
                    )
                }
            }
            if (active) Pill("Active", Tone.ACCENT)
        }
        if (active && s.lastError != null && state == CardState.ONLINE) {
            Text(s.lastError, style = MaterialTheme.typography.bodySmall, color = p.danger)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                active && state == CardState.DENIED -> Button(onClick = onPair, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("Pair again")
                }
                active -> OutlinedButton(onClick = onUse, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text("Reconnect")
                }
                else -> Button(onClick = onUse, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                    Text("Use this computer")
                }
            }
            Box {
                IconButton(
                    onClick = { menu = true },
                    modifier = Modifier.size(48.dp).clip(CircleShape).background(p.surface2),
                ) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "More options for ${c.name}", tint = p.inkSoft)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Rename") },
                        leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                        onClick = { menu = false; onRename() },
                    )
                    DropdownMenuItem(
                        text = { Text("Forget this computer", color = p.danger) },
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
