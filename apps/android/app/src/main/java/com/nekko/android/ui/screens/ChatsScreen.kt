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
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import com.nekko.android.util.localAgo
import com.nekko.android.util.plainText
import com.nekko.protocol.Activity
import com.nekko.protocol.ChatGroup
import com.nekko.protocol.RelayState
import com.nekko.protocol.PcSettings
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.MonitorFormat
import kotlinx.coroutines.launch
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.PollHardware
import com.nekko.android.ui.simple.ModePill
import com.nekko.android.ui.simple.rememberModePill
import com.nekko.android.ui.chat.AgentDetails
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import com.nekko.android.ui.chat.MiniMonitor
import com.nekko.android.monitors.HardwareMonitorController
import com.nekko.android.data.SimpleVisibility
import com.nekko.protocol.ENGINE_PROVIDER_ID
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.runtime.LaunchedEffect
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
    // The computer's monitors: a loaded local model brings them into Simple, the mode pill shows them,
    // and the pill opens into the details.
    val yourComputer = stringResource(R.string.your_computer)
    val monitor = remember(repo) { HardwareMonitorController(repo.caller) { repo.state.value.active?.name ?: yourComputer } }
    val hardware by monitor.state.collectAsStateWithLifecycle()
    val simple = LocalSimple.current.withLocalModel(hardware.localModelLoaded)
    val showHardware = simple.shown("hardware") && s.active != null
    val list = rememberLazyListState()
    val pill = rememberModePill { !list.canScrollBackward }
    var barBottom by remember { mutableFloatStateOf(0f) }
    PollHardware(
        monitor, s.conn == RelayState.ONLINE && s.active != null, full = showHardware,
        light = simple.visibility("hardware") == SimpleVisibility.AUTO || simple.visibility("ph-monitors") == SimpleVisibility.AUTO,
    )
    // The details name loaded models from the Model Server's own list.
    LaunchedEffect(pill.expanded) { if (pill.expanded) runCatching { repo.loadModels(ENGINE_PROVIDER_ID) } }
    val scope = rememberCoroutineScope()
    val modelName: (String) -> String = { id -> s.models.values.firstNotNullOfOrNull { l -> l.firstOrNull { it.id == id }?.name } ?: id }
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
    // Search chats, from the computer menu: a field under the top bar (the mode pill steps away) until closed.
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

    // The quit confirmation, for the banner's ⋮ and the computer menu alike.
    active?.let { SafetyExitDialogs(exits, it.name) }

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = p.paper,
            topBar = {
                Column(Modifier.onGloballyPositioned { barBottom = it.boundsInRoot().bottom }) {
                    CenterAlignedTopAppBar(
                        title = { Text(stringResource(R.string.chats_title), style = MaterialTheme.typography.titleLarge) },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                        // A little shorter than the default, so the mode pill sits right under the title.
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
                            if (active != null) ChatListViewMenu(view, setView, onReorder = { reordering = true })
                            IconButton(onClick = onSettings) {
                                Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.chats_settings), tint = p.inkSoft)
                            }
                            pane?.actions?.invoke(this)
                        },
                    )
                    if (searching) SearchRow(query, onQuery = { query = it }, onClose = closeSearch)
                }
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
            Box(Modifier.fillMaxSize()) {
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
                        LazyColumn(
                            Modifier.fillMaxSize().nestedScroll(pill.scroll).testTag("chats.list"),
                            state = list,
                            contentPadding = PaddingValues(top = if (searching) 0.dp else pill.topInset(simple.pill), bottom = 96.dp),
                        ) {
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
                            if (query.isNotBlank()) {
                                if (found.isEmpty()) {
                                    item(key = "no-match") {
                                        Text(stringResource(R.string.chats_no_match, query.trim()), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft,
                                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                                    }
                                }
                                itemsIndexed(found, key = { _, it -> "found:${it.id}" }) { i, summary ->
                                    if (i > 0) RowDivider(60.dp)
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
                                itemsIndexed(needsYou, key = { _, it -> "needs:${it.id}" }) { i, summary ->
                                    if (i > 0) RowDivider(60.dp)
                                    ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }, onClick = { onOpenChat(summary.id) },
                                        waiting = outbox.waitingFor(summary.id).size, showPreview = view.showPreviews, details = view)
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
                                itemsIndexed(if (all) g.chats else shown, key = { _, it -> "${g.key}:${it.id}" }) { i, summary ->
                                    if (i > 0) RowDivider(60.dp)
                                    if (summary.archived) CompletedRow(summary, onLongClick = { pressedDone = summary }) { onOpenChat(summary.id) }
                                    else ChatRow(summary, s.activity[summary.id], onLongClick = { pressed = summary }, onClick = { onOpenChat(summary.id) },
                                        waiting = outbox.waitingFor(summary.id).size, showPreview = view.showPreviews, details = view)
                                }
                                if (hidden > 0) {
                                    item(key = "more:${g.key}") {
                                        ShowMoreToggle(all, hidden) { expanded = if (all) expanded - g.key else expanded + g.key }
                                    }
                                }
                            }
                            // Monitors, as on an open folding phone's pane: so the feature is not foldable-only.
                            if (onMonitors != null && simple.shown("ph-monitors")) item(key = "monitors") { MonitorsRow(onMonitors) }
                        }
                    }
                }
            }
        }
        // The mode pill floats over the list, out of the way while searching; its gauges open the agent's details.
        ModePill(
            pill, barBottom, floor = null,
            gauges = if (showHardware) { vertical, open -> MiniMonitor(hardware, onOpen = open, compact = pane != null, vertical = vertical, modelName = modelName) } else null,
            details = { AgentDetails(hardware, null, computerName, modelName, monitor::unload) },
            visible = !searching,
        )
    }
}

/** The pill's second line once more than one computer is paired: "2 paired". The phone holds a live connection to one at a time. */
internal fun pairedCaption(count: Int, template: String = "%1\$d paired"): String? = if (count >= 2) template.format(count) else null

/** What the pill's screen-reader label says: the computer, its connection, and how many are paired. */
internal fun pillDescription(name: String, state: String, count: Int, menu: String = "Computer menu", paired: String = "%1\$d paired"): String =
    listOfNotNull(menu, name, state, pairedCaption(count, paired)).joinToString(", ")

private fun connName(s: RelayState) = when (s) {
    RelayState.IDLE -> R.string.simple_conn_idle
    RelayState.CONNECTING -> R.string.simple_conn_connecting
    RelayState.ONLINE -> R.string.simple_conn_online
    RelayState.OFFLINE -> R.string.simple_conn_offline
    RelayState.DENIED -> R.string.simple_conn_denied
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
    val name = s.active?.name ?: stringResource(R.string.chats_computers)
    val pairedWords = stringResource(R.string.simple_paired)
    var open by remember { mutableStateOf(false) }
    var exitsOpen by remember { mutableStateOf(false) }
    val caption = pairedCaption(s.computers.size, pairedWords)
    val dot = when (s.conn) {
        RelayState.ONLINE -> p.success
        RelayState.CONNECTING -> p.accent
        RelayState.OFFLINE -> p.warning
        RelayState.DENIED -> p.danger
        RelayState.IDLE -> p.inkFaint
    }
    val description = pillDescription(name, stringResource(connName(s.conn)), s.computers.size, stringResource(R.string.simple_computer_menu), pairedWords)
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
                    text = { Text(stringResource(R.string.simple_sign_out_or_disconnect), fontWeight = FontWeight.SemiBold) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.simple_back_to_menu)) },
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
                    trailingIcon = if (on) null else ({ Text(stringResource(R.string.simple_connect), style = MaterialTheme.typography.labelMedium, color = p.accent) }),
                    onClick = {
                        close()
                        if (!on) onConnect(c.id)
                    },
                    modifier = Modifier.semantics { selected = on },
                )
            }
            HorizontalDivider(color = p.line)
            DropdownMenuItem(
                text = { Text(stringResource(R.string.simple_search_chats)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                onClick = { close(); onSearch() },
                modifier = Modifier.testTag("chats.menu.search"),
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chats_computers)) },
                leadingIcon = { Icon(Icons.Filled.Computer, contentDescription = null) },
                onClick = { close(); onComputers() },
            )
            if (s.active != null) HorizontalDivider(color = p.line)
            if (s.active != null) DropdownMenuItem(
                text = { Text(stringResource(R.string.simple_sign_out_or_disconnect)) },
                leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null) },
                trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                onClick = { exitsOpen = true },
                modifier = Modifier.testTag("chats.menu.safety"),
            )
        }
    }
}

/** Search chats, under the top bar: focused with the keyboard up; Cancel clears it and brings the mode pill back. */
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
                    placeholder = { Text(stringResource(R.string.simple_search_chats)) },
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
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.simple_cancel_search), tint = p.inkSoft) }
            }
            SlimDivider()
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
internal fun ChatRow(s: SessionSummary, activity: Activity?, onLongClick: () -> Unit, onClick: () -> Unit, waiting: Int = 0, showPreview: Boolean = true, details: ChatListView = ChatListView.STANDARD) {
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
                if (details.showUpdated) Text(localAgo(s.updatedAt), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            }
            if (details.showModel) s.modelId?.let {
                Text(AgentRows.shortModelName(it), style = MaterialTheme.typography.bodySmall, color = p.accent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("chats.row.model"))
            }
            if (details.showContext) (s.contextUsed ?: s.transcriptTokens)?.let { used ->
                val text = s.contextWindow?.let { "${MonitorFormat.tokens(used)}/${MonitorFormat.tokens(it)}" } ?: "${MonitorFormat.tokens(used)} tokens"
                Text(text, style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.testTag("chats.row.context"))
            }
            if (details.showPullRequests && s.prUrls.isNotEmpty()) {
                Text(s.prUrls.take(3).joinToString(" · ") { "#" + it.substringAfterLast('/') } + if (s.prUrls.size > 3) " +${s.prUrls.size - 3}" else "", style = MaterialTheme.typography.bodySmall, color = p.accent, modifier = Modifier.testTag("chats.row.prs"))
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
            color = p.accent,
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
            heading(stringResource(R.string.chats_card_details))
            choice(stringResource(R.string.chats_showmodel), view.showModel) { onChange(view.copy(showModel = !view.showModel)) }
            choice(stringResource(R.string.chats_showcontext), view.showContext) { onChange(view.copy(showContext = !view.showContext)) }
            choice(stringResource(R.string.chats_showpullrequests), view.showPullRequests) { onChange(view.copy(showPullRequests = !view.showPullRequests)) }
            choice(stringResource(R.string.chats_showupdated), view.showUpdated) { onChange(view.copy(showUpdated = !view.showUpdated)) }
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
