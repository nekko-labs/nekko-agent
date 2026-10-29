package com.nekko.android.ui.screens

import androidx.compose.foundation.background
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import com.nekko.android.ui.components.RowDivider
import com.nekko.android.ui.security.SafetyExitDialogs
import com.nekko.android.ui.security.SafetyExitMenuItems
import com.nekko.android.ui.security.SafetyExits
import com.nekko.android.ui.simple.SlimDivider
import com.nekko.android.ui.simple.SlimReveal
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
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.PollHardware
import com.nekko.android.ui.simple.SlimBar
import com.nekko.android.ui.chat.AgentPanel
import com.nekko.android.ui.chat.MiniMonitor
import com.nekko.android.monitors.HardwareMonitorController
import com.nekko.android.data.SimpleVisibility
import com.nekko.protocol.ENGINE_PROVIDER_ID
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.runtime.LaunchedEffect

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
) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    // The computer's monitors: a loaded local model brings them into Simple, the slim row shows them,
    // and the panel under the header has the details.
    val monitor = remember(repo) { HardwareMonitorController(repo.caller) { repo.state.value.active?.name ?: "your computer" } }
    val hardware by monitor.state.collectAsStateWithLifecycle()
    val simple = LocalSimple.current.withLocalModel(hardware.localModelLoaded)
    val showHardware = simple.shown("hardware") && s.active != null
    var showPanel by remember { mutableStateOf(false) }
    PollHardware(
        monitor, s.conn == RelayState.ONLINE && s.active != null, full = showHardware,
        light = !simple.expert && (simple.visibility("hardware") == SimpleVisibility.EXPERT || simple.visibility("ph-monitors") == SimpleVisibility.EXPERT),
    )
    LaunchedEffect(showHardware) { if (!showHardware) showPanel = false }
    // The panel names loaded models from the Model Server's own list.
    LaunchedEffect(showPanel) { if (showPanel) runCatching { repo.loadModels(ENGINE_PROVIDER_ID) } }
    val scope = rememberCoroutineScope()
    val modelName: (String) -> String = { id -> s.models.values.firstNotNullOfOrNull { l -> l.firstOrNull { it.id == id }?.name } ?: id }
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
    // Search chats, from the computer menu: a field in place of the slim row until closed.
    var searching by rememberSaveable { mutableStateOf(false) }
    val closeSearch = { query = ""; searching = false }
    BackHandler(enabled = searching, onBack = closeSearch)
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
    pressed?.let { chat ->
        val delete = s.pcSettings.effectiveAction == PcSettings.ChatAction.DELETE
        ChatActionDialog(
            title = plainText(chat.title).ifEmpty { "New chat" },
            delete = delete,
            computer = active?.name ?: "your computer",
            onDismiss = { pressed = null },
            onConfirm = {
                pressed = null
                if (delete && s.pcSettings.confirmDelete) confirmDelete = chat else run(chat, delete)
            },
        )
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

    // The quit confirmation, for the banner's ⋮ and the computer menu alike.
    active?.let { SafetyExitDialogs(exits, it.name) }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    title = { Text("Chats", style = MaterialTheme.typography.titleLarge) },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                    // A little shorter than the default, so the slim row sits right under the title.
                    expandedHeight = 56.dp,
                    navigationIcon = {
                        ComputerPill(
                            s, exits, compact = pane != null,
                            onSearch = { searching = true },
                            onComputers = onComputers,
                            onConnect = { id -> scope.launch { repo.connect(id) } },
                        )
                    },
                    actions = {
                        IconButton(onClick = onSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = p.inkSoft)
                        }
                        pane?.actions?.invoke(this)
                    },
                )
                if (searching) {
                    SearchRow(query, onQuery = { query = it }, onClose = closeSearch)
                } else {
                    SlimBar(simple.expert, simple.setExpert) {
                        SlimReveal(showHardware) {
                            MiniMonitor(hardware, onOpen = { showPanel = !showPanel }, compact = pane != null, modelName = modelName)
                        }
                    }
                }
            }
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
        Box(Modifier.fillMaxSize()) {
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
                        item(key = "banner") { ConnectionBanner(s, onPair = onPair, onComputers = onComputers, exits = exits) }
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
                        if (query.isNotBlank()) {
                            if (found.isEmpty()) {
                                item(key = "no-match") {
                                    Text("No chats match “${query.trim()}”.", style = MaterialTheme.typography.bodyMedium, color = p.inkSoft,
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                                }
                            }
                            itemsIndexed(found, key = { _, it -> "found:${it.id}" }) { i, summary ->
                                if (i > 0) RowDivider(60.dp)
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
                            itemsIndexed(g.active, key = { _, it -> it.id }) { i, summary ->
                                if (i > 0) RowDivider(60.dp)
                                ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }) { onOpenChat(summary.id) }
                            }
                            if (g.completed.isNotEmpty()) {
                                item(key = "done-toggle:${g.key}") {
                                    CompletedToggle(showDone, g.completed.size) {
                                        showCompleted = if (showDone) showCompleted - g.key else showCompleted + g.key
                                    }
                                }
                                if (showDone) {
                                    itemsIndexed(g.completed, key = { _, it -> it.id }) { i, summary ->
                                        if (i > 0) RowDivider(40.dp)
                                        CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                                    }
                                }
                            }
                        }
                        // Monitors, as on an open folding phone's pane: so the feature is not foldable-only.
                        if (onMonitors != null && simple.shown("ph-monitors")) item(key = "monitors") { MonitorsRow(onMonitors) }
                    }
                }
            }
            AgentPanel(
                open = showPanel && showHardware, state = hardware, chat = null, computer = active?.name ?: "your computer",
                modelName = modelName,
                onUnload = monitor::unload, onDismiss = { showPanel = false },
                modifier = Modifier.padding(top = padding.calculateTopPadding()),
            )
        }
    }
}

/** The pill's second line once more than one computer is paired: "2 paired". The phone holds a live connection to one at a time. */
internal fun pairedCaption(count: Int): String? = if (count >= 2) "$count paired" else null

/** What the pill's screen-reader label says: the computer, its connection, and how many are paired. */
internal fun pillDescription(name: String, state: String, count: Int): String =
    listOfNotNull("Computer menu", name, state, pairedCaption(count)).joinToString(", ")

private fun connName(s: RelayState) = when (s) {
    RelayState.IDLE -> "Not connected"
    RelayState.CONNECTING -> "Connecting"
    RelayState.ONLINE -> "Online"
    RelayState.OFFLINE -> "Offline"
    RelayState.DENIED -> "Refused"
}

/**
 * The computer at the top left: its connection dot, its name, and "N paired" under it when there
 * are several. It opens the computer menu: switch computers, Search chats, Computers (where pairing
 * lives), and Sign out or disconnect (the safety exits, SK-8).
 */
@Composable
private fun ComputerPill(
    s: com.nekko.android.data.ComputersState,
    exits: SafetyExits,
    /** A folding phone's pane: the name gets less room beside the centred title. */
    compact: Boolean,
    onSearch: () -> Unit,
    onComputers: () -> Unit,
    onConnect: (String) -> Unit,
) {
    val p = Nekko.palette
    // With no computer chosen yet the pill still opens the menu, as on the iPhone.
    val name = s.active?.name ?: "Computers"
    var open by remember { mutableStateOf(false) }
    var exitsOpen by remember { mutableStateOf(false) }
    val caption = pairedCaption(s.computers.size)
    val dot = when (s.conn) {
        RelayState.ONLINE -> p.success
        RelayState.CONNECTING -> p.accent
        RelayState.OFFLINE -> p.warning
        RelayState.DENIED -> p.danger
        RelayState.IDLE -> p.inkFaint
    }
    val description = pillDescription(name, connName(s.conn), s.computers.size)
    val close = { open = false; exitsOpen = false }
    Box {
        Box(
            Modifier
                .padding(start = 4.dp)
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(999.dp))
                .clickable(role = Role.Button, onClick = { open = true })
                // Before clearAndSetSemantics, which would clear a tag that came after it.
                .testTag("chats.menu")
                .clearAndSetSemantics { contentDescription = description },
            contentAlignment = Alignment.Center,
        ) {
            Row(
                Modifier.clip(RoundedCornerShape(999.dp)).background(p.surface2).padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(dot))
                Column {
                    Text(name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = if (compact) 88.dp else 132.dp))
                    caption?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = p.inkFaint, maxLines = 1) }
                }
                Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(18.dp))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = close) {
            if (exitsOpen) {
                DropdownMenuItem(
                    text = { Text("Sign out or disconnect", fontWeight = FontWeight.SemiBold) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to the menu") },
                    onClick = { exitsOpen = false },
                )
                HorizontalDivider(color = p.line)
                SafetyExitMenuItems(s, exits, onPicked = close)
                return@DropdownMenu
            }
            s.computers.forEach { c ->
                val on = c.id == s.activeId
                DropdownMenuItem(
                    text = { Text(c.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = { if (on) Icon(Icons.Filled.Check, contentDescription = null, tint = p.accent) else Spacer(Modifier.size(24.dp)) },
                    trailingIcon = if (on) null else ({ Text("Connect", style = MaterialTheme.typography.labelMedium, color = p.accent) }),
                    onClick = {
                        close()
                        if (!on) onConnect(c.id)
                    },
                    modifier = Modifier.semantics { selected = on },
                )
            }
            HorizontalDivider(color = p.line)
            DropdownMenuItem(
                text = { Text("Search chats") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                onClick = { close(); onSearch() },
                modifier = Modifier.testTag("chats.menu.search"),
            )
            DropdownMenuItem(
                text = { Text("Computers") },
                leadingIcon = { Icon(Icons.Filled.Computer, contentDescription = null) },
                onClick = { close(); onComputers() },
            )
            if (s.active != null) HorizontalDivider(color = p.line)
            if (s.active != null) DropdownMenuItem(
                text = { Text("Sign out or disconnect") },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null) },
                trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                onClick = { exitsOpen = true },
                modifier = Modifier.testTag("chats.menu.safety"),
            )
        }
    }
}

/** Search chats, in place of the slim row: focused with the keyboard up; Cancel clears it and brings the row back. */
@Composable
private fun SearchRow(query: String, onQuery: (String) -> Unit, onClose: () -> Unit) {
    val p = Nekko.palette
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }
    SlimReveal(expand = true) {
        Column(Modifier.fillMaxWidth().background(p.paper)) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Search, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
                TextField(
                    value = query,
                    onValueChange = onQuery,
                    placeholder = { Text("Search chats") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                    ),
                    modifier = Modifier.weight(1f).focusRequester(focus).testTag("chats.search"),
                )
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "Cancel search", tint = p.inkSoft) }
            }
            SlimDivider()
        }
    }
}

/** What a long-press offers: the one action the computer is set to (Settings → On <computer>). */
@Composable
private fun ChatActionDialog(title: String, delete: Boolean, computer: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val p = Nekko.palette
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Text(
                if (delete) "Delete it from $computer. You can change this action in Settings."
                else "Move it to Completed on $computer. Nothing is deleted; you can change this action in Settings.",
            )
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
            color = p.accent,
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

/** The line above a saved chat list: when it was saved, and that it isn't live. */
internal fun savedListNote(savedAt: Long, computer: String, now: Long = System.currentTimeMillis(), zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
    val at = java.time.Instant.ofEpochMilli(savedAt).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val time = at.toLocalTime().format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
    val whenText = if (at.toLocalDate() == today) time
    else at.toLocalDate().format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM)) + ", " + time
    return "Saved list from $whenText. It updates when $computer answers."
}
