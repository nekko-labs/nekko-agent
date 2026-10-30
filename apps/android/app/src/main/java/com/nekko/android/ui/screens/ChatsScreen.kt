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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Monitor
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.ConnectionBanner
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import com.nekko.protocol.ChatSearch
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.panes.PaneSlot
import com.nekko.android.ui.security.rememberSafetyExits
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.ago
import com.nekko.android.util.plainText
import com.nekko.protocol.Activity
import com.nekko.protocol.ChatGroup
import com.nekko.protocol.RelayState
import com.nekko.protocol.PcSettings
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.launch
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PushPin
import com.nekko.android.ui.chat.RenameChatDialog

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatsScreen(
    repo: ComputersRepository,
    onOpenChat: (String) -> Unit,
    onNewChat: () -> Unit,
    onPair: () -> Unit,
    onComputers: () -> Unit,
    onSettings: () -> Unit,
    /** The Monitors row at the bottom of the list (the computer's hardware, running chats, what needs you). */
    onMonitors: (() -> Unit)? = null,
    /** Set when the list is one of an open folding phone's two panes: its header actions. */
    pane: PaneSlot? = null,
    /** During the first run, pairing is its step 2: the welcome says so and offers Skip. */
    onSkipFirstRun: (() -> Unit)? = null,
) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    // The banner's ⋮: sign out this phone, stop remote access, quit (SK-8).
    val exits = rememberSafetyExits(repo)
    var pulling by remember { mutableStateOf(false) }
    val active = s.active
    // Long-press on a chat: the computer's own action (Complete or Delete) for it.
    var pressed by remember { mutableStateOf<SessionSummary?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionSummary?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    // Long-press on a completed chat: Restore it, or delete it for good.
    var pressedDone by remember { mutableStateOf<SessionSummary?>(null) }
    // Folded groups and groups showing their completed chats; kept while a chat is open.
    var collapsed by rememberSaveable { mutableStateOf(setOf<String>()) }
    var showCompleted by rememberSaveable { mutableStateOf(setOf<String>()) }
    val groups = remember(s.summaries, s.workspaces) { ChatGroup.of(s.summaries, s.workspaces) }
    // Search: every word, any case or accent, in the title, first prompt or last reply, completed chats too.
    var query by rememberSaveable { mutableStateOf("") }
    val found = remember(s.summaries, query) { if (query.isBlank()) emptyList() else ChatSearch.matches(s.summaries.filter { it.isVisible }, query) }
    val restore: (SessionSummary) -> Unit = { chat ->
        actionError = null
        scope.launch {
            try {
                repo.restoreChat(chat.id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t restore that chat."
            }
        }
    }
    val run: (SessionSummary, Boolean) -> Unit = { chat, delete ->
        actionError = null
        scope.launch {
            try {
                if (delete) repo.deleteChat(chat.id) else repo.completeChat(chat.id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t change that chat."
            }
        }
    }
    // Long-press → Rename: the title on the computer.
    var renaming by remember { mutableStateOf<SessionSummary?>(null) }
    val change: (String, suspend () -> Unit) -> Unit = { failed, action ->
        actionError = null
        scope.launch {
            try {
                action()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                actionError = e.message?.takeIf { it.isNotBlank() } ?: failed
            }
        }
    }
    pressed?.let { chat ->
        val delete = s.pcSettings.effectiveAction == PcSettings.ChatAction.DELETE
        ChatActionDialog(
            title = plainText(chat.title).ifEmpty { "New chat" },
            delete = delete,
            pinned = chat.pinned,
            computer = active?.name ?: "your computer",
            onDismiss = { pressed = null },
            onConfirm = {
                pressed = null
                if (delete && s.pcSettings.confirmDelete) confirmDelete = chat else run(chat, delete)
            },
            onPin = {
                pressed = null
                change("Couldn’t change that chat.") { repo.setPinned(chat.id, !chat.pinned) }
            },
            onRename = { pressed = null; renaming = chat },
        )
    }
    renaming?.let { chat ->
        RenameChatDialog(plainText(chat.title), onDismiss = { renaming = null }) { title ->
            renaming = null
            change("Couldn’t rename that chat.") { repo.renameChat(chat.id, title) }
        }
    }
    pressedDone?.let { chat ->
        AlertDialog(
            onDismissRequest = { pressedDone = null },
            title = { Text(plainText(chat.title).ifEmpty { "New chat" }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            text = { Text("Completed on ${active?.name ?: "your computer"}. Restore it to the active chats, or delete it for good.") },
            confirmButton = {
                TextButton(onClick = { pressedDone = null; restore(chat) }) { Text("Restore", color = p.accent) }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = {
                        pressedDone = null
                        if (s.pcSettings.confirmDelete) confirmDelete = chat else run(chat, true)
                    }) { Text("Delete", color = p.danger) }
                    TextButton(onClick = { pressedDone = null }) { Text("Cancel") }
                }
            },
        )
    }
    confirmDelete?.let { chat ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete this chat?") },
            text = { Text("“${plainText(chat.title).ifEmpty { "New chat" }}” will be deleted from ${active?.name ?: "your computer"} for good. This can’t be undone.") },
            confirmButton = {
                TextButton(onClick = { confirmDelete = null; run(chat, true) }) { Text("Delete", color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }

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
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = p.inkSoft)
                    }
                    pane?.actions?.invoke(this)
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
            Welcome(onPair, Modifier.padding(padding), onSkipFirstRun)
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
                    item(key = "banner") { ConnectionBanner(s, onPair = onPair, onComputers = onComputers, exits = exits) }
                    // The phone and the computer speak different protocol versions (IO-32): which side to update.
                    s.protocolCheck.message(active.name)?.let { text ->
                        item(key = "protocol") { Notice(text, Tone.WARNING, Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("protocol-banner")) }
                    }
                    s.savedListAt?.let { at ->
                        item(key = "saved-list") {
                            Text(
                                savedListNote(at, active.name),
                                style = MaterialTheme.typography.bodySmall,
                                color = p.inkSoft,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                    }
                    item(key = "header") { SectionHeader("On ${active.name}") }
                    actionError?.let { msg -> item(key = "action-error") { Notice(msg, Tone.DANGER, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) } }
                    if (s.summaries.isNotEmpty()) {
                        item(key = "search") {
                            OutlinedTextField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = { Text("Search chats") },
                                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                                trailingIcon = {
                                    if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, contentDescription = "Clear search") }
                                },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("chats.search"),
                            )
                        }
                    }
                    if (query.isNotBlank()) {
                        if (found.isEmpty()) {
                            item(key = "no-match") {
                                Text("No chats match “${query.trim()}”.", style = MaterialTheme.typography.bodyMedium, color = p.inkSoft,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                            }
                        }
                        items(found, key = { "found:${it.id}" }) { summary ->
                            if (summary.archived) CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                            else ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }) { onOpenChat(summary.id) }
                        }
                    } else if (s.summaries.isEmpty()) {
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
                    // The desktop's agent sidebar: General, then each folder; active
                    // chats first, completed ones folded away under Show completed.
                    if (query.isBlank()) groups.forEach { g ->
                        val open = g.key !in collapsed
                        val showDone = g.key in showCompleted
                        item(key = "group:${g.key}") {
                            GroupHeader(g.name, open, g.active.size) {
                                collapsed = if (open) collapsed + g.key else collapsed - g.key
                            }
                        }
                        if (!open) return@forEach
                        if (g.active.isEmpty()) {
                            item(key = "none:${g.key}") {
                                Text(
                                    "No active agents",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.inkFaint,
                                    modifier = Modifier.padding(start = 40.dp, end = 16.dp, top = 2.dp, bottom = 6.dp),
                                )
                            }
                        }
                        items(g.active, key = { it.id }) { summary ->
                            ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }) { onOpenChat(summary.id) }
                        }
                        if (g.completed.isNotEmpty()) {
                            item(key = "done-toggle:${g.key}") {
                                CompletedToggle(showDone, g.completed.size) {
                                    showCompleted = if (showDone) showCompleted - g.key else showCompleted + g.key
                                }
                            }
                            if (showDone) {
                                items(g.completed, key = { it.id }) { summary ->
                                    CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                                }
                            }
                        }
                    }
                    // Monitors, as on an open folding phone's pane: so the feature is not foldable-only.
                    if (onMonitors != null) item(key = "monitors") { MonitorsRow(onMonitors) }
                }
            }
        }
    }
}

/**
 * What a long-press offers: the one action the computer is set to (Settings →
 * On <computer>), plus Pin or Unpin and Rename, as on the desktop.
 */
@Composable
private fun ChatActionDialog(
    title: String,
    delete: Boolean,
    pinned: Boolean,
    computer: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
    onPin: () -> Unit,
    onRename: () -> Unit,
) {
    val p = Nekko.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    if (delete) "Delete it from $computer. You can change this action in Settings."
                    else "Move it to Completed on $computer. Nothing is deleted; you can change this action in Settings.",
                )
                TextButton(onClick = onPin, modifier = Modifier.testTag("chats.pin")) {
                    Icon(Icons.Filled.PushPin, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(if (pinned) "Unpin" else "Pin", modifier = Modifier.padding(start = 8.dp))
                }
                TextButton(onClick = onRename, modifier = Modifier.testTag("chats.rename")) {
                    Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("Rename", modifier = Modifier.padding(start = 8.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(if (delete) "Delete" else "Complete", color = if (delete) p.danger else p.accent)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun ChatRow(s: SessionSummary, activity: Activity?, onLongClick: () -> Unit, onClick: () -> Unit) {
    val p = Nekko.palette
    val preview = plainText(s.lastReplyText ?: s.firstUserText ?: "")
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onLongClickLabel = "Chat actions", onLongClick = onLongClick, onClick = onClick)
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
                if (s.pinned) Icon(Icons.Filled.PushPin, contentDescription = "Pinned", tint = p.warning, modifier = Modifier.size(14.dp))
                Text(ago(s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
            if (preview.isNotEmpty()) {
                Text(preview, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            when (activity) {
                Activity.NEEDS_YOU -> Box(Modifier.padding(top = 4.dp)) { Pill("Needs you", Tone.WARNING, Icons.Filled.Warning) }
                Activity.RUNNING -> Box(Modifier.padding(top = 4.dp)) { Pill("Running", Tone.ACCENT, Icons.Filled.Bolt) }
                null -> Box(Modifier.padding(top = 4.dp)) {
                    if (s.activeWatchCount > 0) {
                        Text("Zz", style = MaterialTheme.typography.labelMedium, color = p.inkFaint,
                            modifier = Modifier.semantics { contentDescription = "Idle" })
                    } else {
                        Icon(Icons.Filled.Check, contentDescription = "Done", tint = p.inkFaint, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
    }
}

/** The last row of the list: the computer's Monitors. */
@Composable
private fun MonitorsRow(onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(p.surface2),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Monitor, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f)) {
            Text("Monitors", style = MaterialTheme.typography.titleMedium, color = p.ink)
            Text("Hardware, running chats, what needs you", style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
    }
}

/** A group's title row (General or a folder): tap to fold it, like the desktop sidebar. */
@Composable
private fun GroupHeader(name: String, open: Boolean, activeCount: Int, onToggle: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = if (open) "Collapse $name" else "Expand $name", onClick = onToggle)
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .padding(start = 12.dp, end = 16.dp, top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = p.inkFaint,
            modifier = Modifier.size(18.dp).rotate(if (open) 90f else 0f),
        )
        Text(
            name.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            color = p.inkFaint,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (!open && activeCount > 0) {
            Text(
                "$activeCount",
                style = MaterialTheme.typography.labelSmall,
                color = p.inkFaint,
                modifier = Modifier.clip(RoundedCornerShape(50)).background(p.surface2).padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

/** "Show completed (N)" / "Hide completed" under a group's active chats. */
@Composable
private fun CompletedToggle(open: Boolean, count: Int, onToggle: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(start = 40.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = p.inkFaint,
            modifier = Modifier.size(14.dp).rotate(if (open) 90f else 0f),
        )
        Text(
            if (open) "Hide completed" else "Show completed ($count)",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
        )
    }
}

/**
 * A completed chat: struck through and muted behind a check, dated by when it
 * was completed, as the desktop's Show completed list draws it. Tap reads it;
 * long-press offers Restore or Delete.
 */
@Composable
private fun CompletedRow(s: SessionSummary, onLongClick: () -> Unit, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onLongClickLabel = "Restore or delete", onLongClick = onLongClick, onClick = onClick)
            .padding(start = 40.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Check, contentDescription = "Completed", tint = p.success, modifier = Modifier.size(14.dp))
        Text(
            plainText(s.title).ifEmpty { "New chat" },
            style = MaterialTheme.typography.bodyMedium.copy(textDecoration = TextDecoration.LineThrough),
            color = p.inkFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(ago(s.archivedAt ?: s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}

/** No computer yet: say what the app does and how to start. */
@Composable
private fun Welcome(onPair: () -> Unit, modifier: Modifier = Modifier, onSkipFirstRun: (() -> Unit)? = null) {
    val p = Nekko.palette
    Column(
        modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (onSkipFirstRun != null) {
            StepLabel(2)
            Spacer(Modifier.height(16.dp))
        }
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
        if (onSkipFirstRun != null) {
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onSkipFirstRun, modifier = Modifier.testTag("firstRun.skip")) { Text("Skip") }
        }
        Spacer(Modifier.height(80.dp))
    }
}

/** The line above a saved chat list: when it was saved, and that it isn't live. */
internal fun savedListNote(savedAt: Long, computer: String, now: Long = System.currentTimeMillis(), zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
    val at = java.time.Instant.ofEpochMilli(savedAt).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val time = at.toLocalTime().format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
    val whenText = if (at.toLocalDate() == today) time
    else at.toLocalDate().format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM)) + ", " + time
    return "Saved list from $whenText. It updates when $computer answers."
}
