package com.nekko.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.ConnectionBanner
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.ago
import com.nekko.android.util.plainText
import com.nekko.protocol.Activity
import com.nekko.protocol.RelayState
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsScreen(
    repo: ComputersRepository,
    onOpenChat: (String) -> Unit,
    onNewChat: () -> Unit,
    onPair: () -> Unit,
    onComputers: () -> Unit,
) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var pulling by remember { mutableStateOf(false) }
    val active = s.active

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Chats", style = MaterialTheme.typography.headlineMedium) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                actions = {
                    IconButton(onClick = onComputers) {
                        Icon(Icons.Filled.Computer, contentDescription = "Computers", tint = p.inkSoft)
                    }
                },
            )
        },
        floatingActionButton = {
            if (active != null) {
                ExtendedFloatingActionButton(
                    onClick = onNewChat,
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    text = { Text("New chat") },
                    containerColor = p.accent,
                    contentColor = p.accentInk,
                )
            }
        },
    ) { padding ->
        if (!s.ready) {
            Box(Modifier.fillMaxSize().padding(padding))
        } else if (active == null) {
            Welcome(onPair, Modifier.padding(padding))
        } else {
            PullToRefreshBox(
                isRefreshing = pulling,
                onRefresh = {
                    scope.launch {
                        pulling = true
                        repo.refresh()
                        pulling = false
                    }
                },
                modifier = Modifier.fillMaxSize().padding(padding),
            ) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    item(key = "banner") { ConnectionBanner(s, onPair = onPair, onComputers = onComputers) }
                    item(key = "header") { SectionHeader("On ${active.name}") }
                    if (s.summaries.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                when {
                                    s.conn != RelayState.ONLINE -> "Chats appear here once your computer is online."
                                    s.summariesLoading -> "Loading chats…"
                                    else -> "No chats yet. Start one with New chat."
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = p.inkFaint,
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                        }
                    }
                    items(s.summaries, key = { it.id }) { summary ->
                        ChatRow(summary, s.activity[summary.id]) { onOpenChat(summary.id) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatRow(s: SessionSummary, activity: Activity?, onClick: () -> Unit) {
    val p = Nekko.palette
    val preview = plainText(s.lastReplyText ?: s.firstUserText ?: "")
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.padding(top = 2.dp).size(32.dp).clip(RoundedCornerShape(8.dp)).background(p.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Computer, contentDescription = null, tint = p.accent, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    plainText(s.title).ifEmpty { "New chat" },
                    style = MaterialTheme.typography.titleMedium,
                    color = p.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(ago(s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
            if (preview.isNotEmpty()) {
                Text(preview, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            when (activity) {
                Activity.NEEDS_YOU -> Box(Modifier.padding(top = 4.dp)) { Pill("Needs you", Tone.WARNING, Icons.Filled.Warning) }
                Activity.RUNNING -> Box(Modifier.padding(top = 4.dp)) { Pill("Running", Tone.ACCENT, Icons.Filled.Bolt) }
                null -> Unit
            }
        }
    }
}

/** No computer yet: say what the app does and how to start. */
@Composable
private fun Welcome(onPair: () -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Column(
        modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)).background(p.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.QrCode2, contentDescription = null, tint = p.accent, modifier = Modifier.size(36.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text("Your agent, in your pocket", style = MaterialTheme.typography.headlineSmall, color = p.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            "Drive Nekko Agent on your computer from here: start chats, follow runs, and approve what it wants to do.",
            style = MaterialTheme.typography.bodyLarge,
            color = p.inkSoft,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onPair, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text("Pair a computer")
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "Scan the QR in Settings → Remote access on your computer.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(80.dp))
    }
}
