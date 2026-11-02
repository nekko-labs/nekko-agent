package com.nekko.android.ui.screens

import androidx.annotation.StringRes
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import com.nekko.protocol.AgentRows
import com.nekko.android.ui.chat.RowChip
import androidx.compose.material.icons.filled.Outbox
import androidx.compose.material.icons.filled.QuestionMark
import androidx.compose.material.icons.outlined.RocketLaunch
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.automirrored.filled.Sort
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.ChatListPrefs
import com.nekko.protocol.ChatGroupOrder
import com.nekko.protocol.ChatSections
import com.nekko.protocol.ChatSection
import com.nekko.protocol.ChatListView
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
import com.nekko.android.util.localAgo
import com.nekko.android.util.plainText
import com.nekko.protocol.Activity
import com.nekko.protocol.ChatGroup
import com.nekko.protocol.RelayState
import com.nekko.protocol.PcSettings
import com.nekko.protocol.SessionSummary
import kotlinx.coroutines.launch
import androidx.compose.material3.CircularProgressIndicator
import com.nekko.android.data.OutboxItem
import androidx.compose.material.icons.filled.Schedule
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
    /** Where the view menu and the group order are kept; null keeps them for this screen only (tests). */
    phonePrefs: PhonePrefs? = null,
) {
    val s by repo.state.collectAsStateWithLifecycle()
    val outbox by repo.outbox.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    val newChat = stringResource(R.string.chats_new_chat)
    // The banner's ⋮: sign out this phone, stop remote access, quit (SK-8).
    val exits = rememberSafetyExits(repo)
    var pulling by remember { mutableStateOf(false) }
    val active = s.active
    val computerName = active?.name ?: stringResource(R.string.chats_your_computer)
    // Long-press on a chat: the computer's own action (Complete or Delete) for it.
    var pressed by remember { mutableStateOf<SessionSummary?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionSummary?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    // Long-press on a completed chat: Restore it, or delete it for good.
    var pressedDone by remember { mutableStateOf<SessionSummary?>(null) }
    // Folded groups and groups showing all their chats; kept while a chat is open.
    var collapsed by rememberSaveable { mutableStateOf(setOf<String>()) }
    var expanded by rememberSaveable { mutableStateOf(setOf<String>()) }
    // The view menu (group by, sort by, what is shown) and the project groups' order, kept on this phone.
    val localView = remember { MutableStateFlow(ChatListView.STANDARD) }
    val localOrder = remember { MutableStateFlow(emptyMap<String, List<String>>()) }
    val view by (phonePrefs?.flow(ChatListPrefs.VIEW) ?: localView).collectAsStateWithLifecycle()
    val orders by (phonePrefs?.flow(ChatListPrefs.GROUP_ORDER) ?: localOrder).collectAsStateWithLifecycle()
    val setView: (ChatListView) -> Unit = { v -> if (phonePrefs != null) phonePrefs.set(ChatListPrefs.VIEW, v) else localView.value = v }
    val groupOrder = orders[active?.id].orEmpty()
    val setGroupOrder: (List<String>) -> Unit = { keys ->
        active?.id?.let { id -> if (phonePrefs != null) phonePrefs.set(ChatListPrefs.GROUP_ORDER, orders + (id to keys)) else localOrder.value = orders + (id to keys) }
    }
    var reordering by remember { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    val sections = remember(s.summaries, s.workspaces, view, s.activity, groupOrder) {
        ChatSections.make(s.summaries, s.workspaces, view, s.activity, groupOrder, now)
    }
    // Status groups lead with their own Needs you group; other views get one at the top.
    val needsYou = remember(s.summaries, s.activity, view) {
        if (view.groupBy == ChatListView.GroupBy.STATUS) emptyList() else s.summaries.filter { !it.archived && s.activity[it.id] == Activity.NEEDS_YOU }
    }
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
                actionError = e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.chats_restore_failed)
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
                actionError = e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.chats_change_failed)
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
            title = plainText(chat.title).ifEmpty { newChat },
            delete = delete,
            pinned = chat.pinned,
            computer = computerName,
            onDismiss = { pressed = null },
            onConfirm = {
                pressed = null
                if (delete && s.pcSettings.confirmDelete) confirmDelete = chat else run(chat, delete)
            },
            onPin = {
                pressed = null
                change(res.getString(R.string.chats_change_failed)) { repo.setPinned(chat.id, !chat.pinned) }
            },
            onRename = { pressed = null; renaming = chat },
        )
    }
    renaming?.let { chat ->
        RenameChatDialog(plainText(chat.title), onDismiss = { renaming = null }) { title ->
            renaming = null
            change(res.getString(R.string.chats_rename_failed)) { repo.renameChat(chat.id, title) }
        }
    }
    pressedDone?.let { chat ->
        AlertDialog(
            onDismissRequest = { pressedDone = null },
            title = { Text(plainText(chat.title).ifEmpty { newChat }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            text = { Text(stringResource(R.string.chats_completed_on, computerName)) },
            confirmButton = {
                TextButton(onClick = { pressedDone = null; restore(chat) }) { Text(stringResource(R.string.chats_restore), color = p.accent) }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = {
                        pressedDone = null
                        if (s.pcSettings.confirmDelete) confirmDelete = chat else run(chat, true)
                    }) { Text(stringResource(R.string.chats_delete), color = p.danger) }
                    TextButton(onClick = { pressedDone = null }) { Text(stringResource(R.string.chats_cancel)) }
                }
            },
        )
    }
    confirmDelete?.let { chat ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(stringResource(R.string.chats_delete_title)) },
            text = { Text(stringResource(R.string.chats_delete_body, plainText(chat.title).ifEmpty { newChat }, computerName)) },
            confirmButton = {
                TextButton(onClick = { confirmDelete = null; run(chat, true) }) { Text(stringResource(R.string.chats_delete), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.chats_cancel)) } },
        )
    }

    if (reordering) {
        ReorderGroupsDialog(
            sections.map { it.key to groupTitle(it.key, it.name) },
            onDismiss = { reordering = false },
            onDone = { keys -> reordering = false; setGroupOrder(keys) },
        )
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.chats_title), style = MaterialTheme.typography.headlineMedium) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                actions = {
                    if (active != null) ChatListViewMenu(view, setView, onReorder = { reordering = true })
                    IconButton(onClick = onComputers) {
                        Icon(Icons.Filled.Computer, contentDescription = stringResource(R.string.chats_computers), tint = p.inkSoft)
                    }
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.chats_settings), tint = p.inkSoft)
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
                    text = { Text(newChat) },
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
                LazyColumn(Modifier.fillMaxSize().testTag("chats.list"), contentPadding = PaddingValues(bottom = 96.dp)) {
                    item(key = "banner") { ConnectionBanner(s, onPair = onPair, onComputers = onComputers, exits = exits) }
                    // Offline mode: what waits on the phone, and chats started offline not created yet.
                    if (outbox.waiting.isNotEmpty() && s.conn != RelayState.ONLINE) {
                        item(key = "outbox-note") {
                            val n = outbox.waiting.size
                            Notice(
                                if (n == 1) stringResource(R.string.chats_outbox_note_one, active.name) else stringResource(R.string.chats_outbox_note_other, n, active.name),
                                Tone.FAINT,
                                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("chats.outboxNote"),
                            )
                        }
                    }
                    val pendingNew = outbox.pendingNewChats.filter { it.id !in outbox.direct }
                    if (pendingNew.isNotEmpty()) {
                        item(key = "pending-header") { SectionHeader(stringResource(R.string.chats_waiting_to_send)) }
                        items(pendingNew, key = { "pending:${it.chatKey}" }) { item ->
                            PendingNewChatRow(item, sending = item.id == outbox.sendingId, onDelete = { repo.outbox.remove(item.id) })
                        }
                    }
                    // The phone and the computer speak different protocol versions (IO-32): which side to update.
                    s.protocolCheck.message(active.name)?.let { text ->
                        item(key = "protocol") { Notice(text, Tone.WARNING, Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("protocol-banner")) }
                    }
                    s.savedListAt?.let { at ->
                        item(key = "saved-list") {
                            Text(
                                savedListNote(at, active.name, template = stringResource(R.string.chats_saved_list_note)),
                                style = MaterialTheme.typography.bodySmall,
                                color = p.inkSoft,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                    }
                    item(key = "header") { SectionHeader(stringResource(R.string.chats_on_computer, active.name)) }
                    actionError?.let { msg -> item(key = "action-error") { Notice(msg, Tone.DANGER, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) } }
                    if (s.summaries.isNotEmpty()) {
                        item(key = "search") {
                            OutlinedTextField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = { Text(stringResource(R.string.chats_search_placeholder)) },
                                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                                trailingIcon = {
                                    if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chats_clear_search)) }
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
                                Text(stringResource(R.string.chats_no_match, query.trim()), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                            }
                        }
                        items(found, key = { "found:${it.id}" }) { summary ->
                            if (summary.archived) CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                            else ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }, onClick = { onOpenChat(summary.id) }, waiting = outbox.waitingFor(summary.id).size)
                        }
                    } else if (s.summaries.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                stringResource(
                                    when {
                                        s.conn != RelayState.ONLINE -> R.string.chats_empty_offline
                                        s.summariesLoading -> R.string.chats_loading
                                        else -> R.string.chats_empty
                                    },
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                                color = p.inkFaint,
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                        }
                    }
                    if (query.isBlank() && needsYou.isNotEmpty()) {
                        item(key = "needs-you") { GroupHeader(stringResource(R.string.chats_needs_you), open = true, count = "${needsYou.size}", onToggle = null) }
                        items(needsYou, key = { "needs:${it.id}" }) { summary ->
                            ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }, onClick = { onOpenChat(summary.id) },
                                waiting = outbox.waitingFor(summary.id).size, showPreview = view.showPreviews)
                        }
                    }
                    // The desktop's agent sidebar as the view menu arranges it: by project (General, then each
                    // folder, in the order arranged here), status, date or none; the recent few, then Show more.
                    if (query.isBlank()) sections.forEach { g ->
                        val open = g.key !in collapsed
                        val all = g.key in expanded
                        val (shown, hidden) = ChatSections.split(g, s.activity, now)
                        item(key = "group:${g.key}") {
                            GroupHeader(
                                groupTitle(g.key, g.name), open, groupCounts(g),
                                onReorder = if (view.canReorderGroups && sections.size > 1) ({ reordering = true }) else null,
                            ) { collapsed = if (open) collapsed + g.key else collapsed - g.key }
                        }
                        if (!open) return@forEach
                        if (g.chats.isEmpty()) {
                            item(key = "none:${g.key}") {
                                Text(
                                    stringResource(R.string.chats_no_active_agents),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.inkFaint,
                                    modifier = Modifier.padding(start = 40.dp, end = 16.dp, top = 2.dp, bottom = 6.dp),
                                )
                            }
                        }
                        items(if (all) g.chats else shown, key = { "${g.key}:${it.id}" }) { summary ->
                            if (summary.archived) CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                            else ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }, onClick = { onOpenChat(summary.id) },
                                waiting = outbox.waitingFor(summary.id).size, showPreview = view.showPreviews)
                        }
                        if (hidden > 0) {
                            item(key = "more:${g.key}") {
                                ShowMoreToggle(all, hidden) { expanded = if (all) expanded - g.key else expanded + g.key }
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
                    if (delete) stringResource(R.string.chats_action_delete_body, computer)
                    else stringResource(R.string.chats_action_complete_body, computer),
                )
                TextButton(onClick = onPin, modifier = Modifier.testTag("chats.pin")) {
                    Icon(Icons.Filled.PushPin, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(if (pinned) R.string.chats_unpin else R.string.chats_pin), modifier = Modifier.padding(start = 8.dp))
                }
                TextButton(onClick = onRename, modifier = Modifier.testTag("chats.rename")) {
                    Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.chats_rename), modifier = Modifier.padding(start = 8.dp))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(if (delete) R.string.chats_delete else R.string.chats_complete), color = if (delete) p.danger else p.accent)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.chats_cancel)) } },
    )
}

@Composable
internal fun ChatRow(s: SessionSummary, activity: Activity?, onLongClick: () -> Unit, onClick: () -> Unit, waiting: Int = 0, showPreview: Boolean = true) {
    val p = Nekko.palette
    val preview = plainText(s.lastReplyText ?: s.firstUserText ?: "")
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(role = Role.Button, onLongClickLabel = stringResource(R.string.chats_chat_actions), onLongClick = onLongClick, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A glyph column says what the chat is doing before the title is read
        // (the desktop's StatusIcon, as on the iPhone); the facts sit under the preview as chips.
        Box(Modifier.padding(top = 2.dp).size(22.dp), contentAlignment = Alignment.Center) {
            ChatStatusIcon(activity, waiting > 0, s.activeWatchCount)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    plainText(s.title).ifEmpty { stringResource(R.string.chats_new_chat) },
                    style = MaterialTheme.typography.titleMedium,
                    color = p.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (s.pinned) Icon(Icons.Filled.PushPin, contentDescription = stringResource(R.string.chats_pinned), tint = p.warning, modifier = Modifier.size(14.dp))
                Text(localAgo(s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
            if (showPreview && preview.isNotEmpty()) {
                Text(preview, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (activity != null || waiting > 0) {
                Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    when (activity) {
                        Activity.NEEDS_YOU -> RowChip(stringResource(R.string.chats_needs_you), tone = AgentRows.Tone.WARN)
                        Activity.RUNNING -> RowChip(stringResource(R.string.chats_working), accent = true)
                        null -> Unit
                    }
                    // Prompts written offline for this chat, still in the outbox.
                    if (waiting > 0) {
                        val waitingDesc = if (waiting == 1) stringResource(R.string.chats_prompts_waiting_one) else stringResource(R.string.chats_prompts_waiting_other, waiting)
                        Row(
                            Modifier.semantics(mergeDescendants = true) {
                                contentDescription = waitingDesc
                            },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(Icons.Filled.Outbox, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(14.dp))
                            Text(stringResource(R.string.chats_n_waiting, waiting), style = MaterialTheme.typography.labelMedium, color = p.inkSoft)
                        }
                    }
                }
            }
        }
    }
}

/**
 * What a chat is doing, as one glyph in the desktop's shapes (StatusIcon), so
 * colour is never the only cue: a rocket while it works, a question mark when
 * it needs you, a clock while prompts wait to send, a check when done, and
 * "Zz" when it is idle with a watch armed.
 */
@Composable
internal fun ChatStatusIcon(activity: Activity?, waiting: Boolean, activeWatchCount: Long) {
    val p = Nekko.palette
    val status = when {
        activity == Activity.RUNNING -> R.string.chats_working
        activity == Activity.NEEDS_YOU -> R.string.chats_needs_you
        waiting -> R.string.chats_waiting_to_send
        activeWatchCount > 0 -> R.string.chats_idle
        else -> R.string.chats_status_done
    }
    val label = stringResource(status)
    val m = Modifier.size(18.dp).semantics { contentDescription = label }
    when (status) {
        R.string.chats_working -> Icon(Icons.Outlined.RocketLaunch, contentDescription = null, tint = p.success, modifier = m)
        R.string.chats_needs_you -> Icon(Icons.Filled.QuestionMark, contentDescription = null, tint = p.warning, modifier = m)
        R.string.chats_waiting_to_send -> Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkFaint, modifier = m)
        R.string.chats_idle -> Text("Zz", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = p.inkFaint, modifier = Modifier.semantics { contentDescription = label })
        else -> Icon(Icons.Filled.Check, contentDescription = null, tint = p.inkFaint, modifier = m)
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
            Text(stringResource(R.string.chats_monitors), style = MaterialTheme.typography.titleMedium, color = p.ink)
            Text(stringResource(R.string.chats_monitors_detail), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
    }
}

/**
 * A group's title row: tap to fold it, like the desktop sidebar, with its
 * counts ("3 active · 12 done"). Project groups offer Reorder groups on a long
 * press (and as an accessibility action).
 */
@Composable
private fun GroupHeader(name: String, open: Boolean, count: String, onReorder: (() -> Unit)? = null, onToggle: (() -> Unit)?) {
    val p = Nekko.palette
    val toggleLabel = stringResource(if (open) R.string.chats_collapse_group else R.string.chats_expand_group, name)
    val reorderLabel = if (onReorder != null) stringResource(R.string.chats_reorder_groups) else null
    val stateLabel = stringResource(if (open) R.string.chats_expanded else R.string.chats_collapsed)
    Row(
        Modifier
            .fillMaxWidth()
            .then(
                if (onToggle == null) Modifier
                else Modifier.combinedClickable(
                    role = Role.Button,
                    onClickLabel = toggleLabel,
                    onLongClickLabel = reorderLabel,
                    onLongClick = onReorder,
                    onClick = onToggle,
                ).semantics { stateDescription = stateLabel },
            )
            .padding(start = 12.dp, end = 16.dp, top = 14.dp, bottom = 6.dp)
            .testTag("chats.group"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = if (onToggle == null) Color.Transparent else p.inkFaint,
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
        if (count.isNotEmpty()) Text(count, style = MaterialTheme.typography.labelSmall, color = p.inkFaint, maxLines = 1)
    }
}

/** "3 active · 12 done", as the desktop's group headings count. */
@Composable
private fun groupCounts(g: ChatSection): String = buildList {
    if (g.activeCount > 0) add(stringResource(R.string.chats_count_active, g.activeCount))
    if (g.doneCount > 0) add(stringResource(R.string.chats_count_done, g.doneCount))
}.joinToString(" · ")

/** "Show N more" / "Show fewer" under a group's recent chats. */
@Composable
private fun ShowMoreToggle(open: Boolean, hidden: Int, onToggle: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(start = 40.dp, end = 16.dp, top = 6.dp, bottom = 6.dp)
            .testTag("chats.showMore"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
            contentDescription = null,
            tint = p.inkSoft,
            modifier = Modifier.size(16.dp),
        )
        Text(if (open) stringResource(R.string.chats_show_fewer) else stringResource(R.string.chats_show_more, hidden), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, color = p.inkSoft)
    }
}

/** Group by, sort by, and what is shown: the desktop Agents panel's view menu, as on the iPhone. */
@Composable
private fun ChatListViewMenu(view: ChatListView, onChange: (ChatListView) -> Unit, onReorder: () -> Unit) {
    val p = Nekko.palette
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("chats.view")) {
            Icon(
                if (view.isStandard) Icons.AutoMirrored.Outlined.Sort else Icons.AutoMirrored.Filled.Sort,
                contentDescription = stringResource(R.string.chats_view_options),
                tint = if (view.isStandard) p.inkSoft else p.accent,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            @Composable
            fun heading(text: String) = Text(
                text.uppercase(), style = MaterialTheme.typography.labelSmall, color = p.inkFaint, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 2.dp),
            )
            @Composable
            fun choice(text: String, on: Boolean, change: () -> Unit) = DropdownMenuItem(
                text = { Text(text) },
                leadingIcon = { Icon(Icons.Filled.Check, contentDescription = null, tint = if (on) p.accent else Color.Transparent) },
                onClick = change,
                modifier = Modifier.semantics { selected = on },
            )
            heading(stringResource(R.string.chats_group_by))
            ChatListView.GroupBy.entries.forEach { g -> choice(stringResource(groupName(g)), view.groupBy == g) { onChange(view.copy(groupBy = g)) } }
            HorizontalDivider()
            heading(stringResource(R.string.chats_sort_by))
            ChatListView.SortBy.entries.forEach { o -> choice(stringResource(sortName(o)), view.sortBy == o) { onChange(view.withSort(o)) } }
            // Manual order has no direction: it is whatever was dragged on the computer.
            if (view.sortBy != ChatListView.SortBy.MANUAL) {
                HorizontalDivider()
                heading(stringResource(R.string.chats_order))
                val name = view.sortBy == ChatListView.SortBy.NAME
                choice(stringResource(if (name) R.string.chats_a_to_z else R.string.chats_oldest_first), view.ascending) { onChange(view.copy(ascending = true)) }
                choice(stringResource(if (name) R.string.chats_z_to_a else R.string.chats_newest_first), !view.ascending) { onChange(view.copy(ascending = false)) }
            }
            HorizontalDivider()
            heading(stringResource(R.string.chats_show))
            choice(stringResource(R.string.chats_previews), view.showPreviews) { onChange(view.copy(showPreviews = !view.showPreviews)) }
            choice(stringResource(R.string.chats_completed_chats), view.showCompleted) { onChange(view.copy(showCompleted = !view.showCompleted)) }
            choice(stringResource(R.string.chats_empty_groups), view.showEmptyGroups) { onChange(view.copy(showEmptyGroups = !view.showEmptyGroups)) }
            if (view.canReorderGroups) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chats_reorder_groups_menu)) },
                    leadingIcon = { Icon(Icons.Filled.SwapVert, contentDescription = null) },
                    onClick = { open = false; onReorder() },
                    modifier = Modifier.testTag("chats.reorder"),
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chats_reset_defaults)) },
                enabled = !view.isStandard,
                onClick = { open = false; onChange(ChatListView.STANDARD) },
            )
        }
    }
}

@StringRes
private fun groupName(g: ChatListView.GroupBy): Int = when (g) {
    ChatListView.GroupBy.PROJECT -> R.string.chats_group_project
    ChatListView.GroupBy.STATUS -> R.string.chats_group_status
    ChatListView.GroupBy.DATE -> R.string.chats_group_date
    ChatListView.GroupBy.NONE -> R.string.chats_group_none
}

@StringRes
private fun sortName(s: ChatListView.SortBy): Int = when (s) {
    ChatListView.SortBy.MANUAL -> R.string.chats_sort_manual
    ChatListView.SortBy.UPDATED -> R.string.chats_sort_updated
    ChatListView.SortBy.NAME -> R.string.chats_sort_name
}

/**
 * The project groups in a list with Move up / Move down on each, kept on this
 * phone for this computer (the iPhone's Reorder groups sheet).
 */
@Composable
private fun ReorderGroupsDialog(groups: List<Pair<String, String>>, onDismiss: () -> Unit, onDone: (List<String>) -> Unit) {
    val p = Nekko.palette
    var order by remember(groups) { mutableStateOf(groups) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chats_reorder_groups)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                order.forEachIndexed { i, (key, name) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("groups.row"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(name, style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        IconButton(enabled = i > 0, onClick = { order = ChatGroupOrder.move(order.map { it.first }, key, order[i - 1].first).map { k -> order.first { it.first == k } } }) {
                            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = stringResource(R.string.chats_move_up, name))
                        }
                        IconButton(enabled = i < order.lastIndex, onClick = { order = ChatGroupOrder.move(order.map { it.first }, key, order.getOrNull(i + 2)?.first).map { k -> order.first { it.first == k } } }) {
                            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.chats_move_down, name))
                        }
                    }
                }
                Text(stringResource(R.string.chats_order_kept), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = { TextButton(onClick = { onDone(order.map { it.first }) }, modifier = Modifier.testTag("groups.done")) { Text(stringResource(R.string.chats_done)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.chats_cancel)) } },
    )
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
            .combinedClickable(role = Role.Button, onLongClickLabel = stringResource(R.string.chats_restore_or_delete), onLongClick = onLongClick, onClick = onClick)
            .padding(start = 40.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.chats_completed), tint = p.success, modifier = Modifier.size(14.dp))
        Text(
            plainText(s.title).ifEmpty { stringResource(R.string.chats_new_chat) },
            style = MaterialTheme.typography.bodyMedium.copy(textDecoration = TextDecoration.LineThrough),
            color = p.inkFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(localAgo(s.archivedAt ?: s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
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
        Text(stringResource(R.string.chats_intro_title), style = MaterialTheme.typography.headlineSmall, color = p.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(R.string.chats_welcome_body),
            style = MaterialTheme.typography.bodyLarge,
            color = p.inkSoft,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onPair, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.chats_pair_title))
        }
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(R.string.chats_welcome_scan),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            textAlign = TextAlign.Center,
        )
        if (onSkipFirstRun != null) {
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onSkipFirstRun, modifier = Modifier.testTag("firstRun.skip")) { Text(stringResource(R.string.chats_skip)) }
        }
        Spacer(Modifier.height(80.dp))
    }
}

/**
 * The line above a saved chat list: when it was saved, and that it isn't live.
 * [template] is R.string.chats_saved_list_note in the phone's language (%1$s the time, %2$s the computer).
 */
internal fun savedListNote(
    savedAt: Long,
    computer: String,
    now: Long = System.currentTimeMillis(),
    zone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
    template: String = "Saved list from %1\$s. It updates when %2\$s answers.",
): String = savedNote(template, savedAt, computer, now, zone)

/** "Saved copy from 10:42. It updates when Mac answers.": a chat read from the phone's copy (OF-5). */
internal fun savedCopyNote(
    savedAt: Long,
    computer: String,
    now: Long = System.currentTimeMillis(),
    zone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
    template: String = "Saved copy from %1\$s. It updates when %2\$s answers.",
): String = savedNote(template, savedAt, computer, now, zone)

private fun savedNote(template: String, savedAt: Long, computer: String, now: Long, zone: java.time.ZoneId): String {
    val at = java.time.Instant.ofEpochMilli(savedAt).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val time = at.toLocalTime().format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT))
    val whenText = if (at.toLocalDate() == today) time
    else at.toLocalDate().format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM)) + ", " + time
    return String.format(template, whenText, computer)
}

/** A chat started offline (offline mode): its first message, until the computer creates it. */
@Composable
private fun PendingNewChatRow(item: OutboxItem, sending: Boolean, onDelete: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp).testTag("chats.pendingNew"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(p.surface2), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(item.preview, style = MaterialTheme.typography.titleMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(item.lastError ?: stringResource(R.string.chats_pending_new_chat), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 2)
        }
        if (sending) {
            CircularProgressIndicator(Modifier.padding(12.dp).size(18.dp), strokeWidth = 2.dp, color = p.accent)
        } else {
            IconButton(onClick = onDelete) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chats_delete_waiting_chat), tint = p.inkSoft) }
        }
    }
}

/** A group's name: a folder's own, or the list's built-in groups in the phone's language. */
@Composable
private fun groupTitle(key: String, name: String): String = when (key) {
    ChatGroup.GENERAL -> stringResource(R.string.chats_group_general)
    ChatSection.COMPLETED -> stringResource(R.string.chats_group_completed)
    "all" -> stringResource(R.string.chats_group_all)
    "status:input" -> stringResource(R.string.chats_group_needs_you)
    "status:working" -> stringResource(R.string.chats_group_working)
    "status:idle" -> stringResource(R.string.chats_group_idle)
    "date:today" -> stringResource(R.string.chats_group_today)
    "date:yesterday" -> stringResource(R.string.chats_group_yesterday)
    "date:week" -> stringResource(R.string.chats_group_week)
    "date:month" -> stringResource(R.string.chats_group_month)
    "date:older" -> stringResource(R.string.chats_group_older)
    else -> name
}
