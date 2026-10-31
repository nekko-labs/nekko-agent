package com.nekko.android.ui.screens

import com.nekko.android.voice.DictationController
import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.core.content.FileProvider
import com.nekko.android.chat.PhotoTray
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.chat.AttachUi
import java.io.File
import com.nekko.android.ui.chat.MicUi
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.DisposableEffect
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import android.content.pm.PackageManager
import android.Manifest
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Difference
import com.nekko.android.ui.chat.ChangesSheet
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.PurposeGroupCard
import com.nekko.android.ui.chat.AgentContext
import com.nekko.android.ui.chat.LocalAgentContext
import com.nekko.android.ui.chat.SubagentGroup
import com.nekko.android.ui.chat.allSubagents
import com.nekko.android.ui.chat.ChatColumns
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.chat.QuestionCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Block
import com.nekko.protocol.Purpose
import com.nekko.protocol.PurposeRun
import java.util.Locale
import android.content.ClipData
import android.content.ClipDescription
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.draganddrop.dragAndDropSource
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.DragAndDropTransferData
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.draw.alpha
import com.nekko.android.ui.components.Dot
import com.nekko.android.ui.chat.ForkAction
import com.nekko.android.ui.files.FilesDialog
import com.nekko.android.ui.previews.PreviewWindow
import com.nekko.android.previews.LocalChatPreviews
import androidx.compose.runtime.CompositionLocalProvider
import com.nekko.android.ui.git.GitDialog
import com.nekko.android.ui.terminal.TerminalsDialog
import androidx.compose.material.icons.filled.Terminal
import com.nekko.android.ui.git.PrChip
import com.nekko.android.ui.git.PrSheet
import com.nekko.protocol.PullRequest
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.ui.platform.testTag
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import com.nekko.android.ui.panes.PaneSlot
import com.nekko.android.ui.chat.ChatOptionsRow
import com.nekko.android.ui.chat.ModeToggle
import com.nekko.android.ui.chat.ModelEffortSheet
import com.nekko.android.ui.chat.MonitorSheet
import com.nekko.android.ui.chat.MonitorStrip
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.nekko.protocol.RelayState
import com.nekko.protocol.ENGINE_PROVIDER_ID
import com.nekko.protocol.RelayException
import com.nekko.android.ui.chat.ChatModeDialog
import com.nekko.android.ui.chat.WaitingList
import com.nekko.android.ui.chat.RefusalNote
import com.nekko.android.ui.chat.RenameChatDialog
import com.nekko.android.ui.security.PendingStepUp
import com.nekko.android.ui.security.StepUpSheet
import com.nekko.android.ui.settings.modeTitle
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Shield

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    vm: ChatViewModel,
    initialDraft: String? = null,
    dictationOn: Boolean = false,
    onBack: () -> Unit,
    /** Open another chat: one forked from here, with [draft] waiting in its message box (AN-29). */
    onOpenChat: (id: String, draft: String?) -> Unit = { _, _ -> },
    /** Set when the chat is one of an open folding phone's two panes (header actions, drag and drop, tabletop). */
    pane: PaneSlot? = null,
    /** The composer's **+** → New agent. */
    onNewChat: (() -> Unit)? = null,
) {
    val chat by vm.ui.collectAsStateWithLifecycle()
    val watches by vm.watches.collectAsStateWithLifecycle()
    val subagents by vm.subagents.collectAsStateWithLifecycle()
    val agentContext = AgentContext(watches, subagents.children, subagents.activity, chat.running, chat.modelId)
    val completedAt by vm.completedAt.collectAsStateWithLifecycle()
    val changesAllowed by vm.changesAllowed.collectAsStateWithLifecycle()
    val insert by vm.insert.collectAsStateWithLifecycle()
    var showChanges by remember { mutableStateOf(false) }
    val expert by vm.expert.collectAsStateWithLifecycle()
    val hardware by vm.hardware.state.collectAsStateWithLifecycle()
    val computers by vm.computers.collectAsStateWithLifecycle()
    val computerName = computers.active?.name ?: "your computer"
    var showModelEffort by remember { mutableStateOf(false) }
    var showMonitor by remember { mutableStateOf(false) }
    // Expert re-reads the hardware every 3 s, only while it is on, this chat is on screen and the computer is reachable.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val online = computers.conn == RelayState.ONLINE
    // The model's name for the row under the message box (the computer's list, cached for the connection).
    LaunchedEffect(chat.providerId, online) { if (online) chat.providerId?.let { vm.loadModels(it) } }
    // The Monitor names loaded models from the Model Server's own list.
    LaunchedEffect(showMonitor, online) { if (showMonitor && online) vm.loadModels(ENGINE_PROVIDER_ID) }
    if (expert && online) {
        LaunchedEffect(vm, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { vm.hardware.poll() } }
    }
    var showMenu by remember { mutableStateOf(false) }
    val pinned by vm.pinned.collectAsStateWithLifecycle()
    var showRename by remember { mutableStateOf(false) }
    var showMode by remember { mutableStateOf(false) }
    // A mode raise the computer wants a second factor for (SK-7): the sheet asks, then sends it again.
    var modeStepUp by remember { mutableStateOf<PendingStepUp?>(null) }
    var prs by remember(vm.sessionId) { mutableStateOf<List<PullRequest>>(emptyList()) }
    var showPrs by remember { mutableStateOf(false) }
    // The chat's pull request chip: read when the chat opens, after each turn, and when Git or the
    // pull request sheet closes (a merge or close from the phone changes it).
    var prReads by remember { mutableIntStateOf(0) }
    LaunchedEffect(vm.sessionId, chat.running, prReads) {
        if (!chat.running) try { prs = vm.pullRequests(refresh = prReads > 0) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) {}
    }
    var restoring by remember { mutableStateOf(false) }
    var restoreError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val p = Nekko.palette
    val mic = rememberMic(vm.dictation.takeIf { dictationOn })
    val attach = rememberAttach(vm)
    val list = rememberLazyListState()
    val prompts by vm.prompts.collectAsStateWithLifecycle()
    val context = LocalContext.current
    // Fork the chat from a saved message: a prompt goes back into the new chat's box, a reply keeps
    // everything up to the next prompt. Streaming blocks aren't saved yet, so they offer Copy only.
    val forkAction: (Block) -> ForkAction? = { block ->
        if ((block is Block.User || (block is Block.Assistant && !block.streaming)) && vm.canFork(block)) {
            ForkAction(if (block is Block.User) "Edit in a new chat" else "Fork from here") {
                scope.launch {
                    try {
                        val (id, draft) = vm.fork(block)
                        onOpenChat(id, draft)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        android.widget.Toast.makeText(context, e.message ?: "Couldn’t fork the chat.", android.widget.Toast.LENGTH_LONG).show()
                    }
                }
            }
        } else {
            null
        }
    }

    // Stable keys: a provider that reuses a call id across turns gets a suffix.
    val keyed = remember(chat.blocks) {
        val seen = HashMap<String, Int>()
        chat.blocks.map { b ->
            val kind = when (b) {
                is Block.User -> "user"
                is Block.Assistant -> "assistant"
                is Block.Tool -> "tool"
            }
            val base = "$kind:${b.id}"
            val n = seen.getOrDefault(base, 0)
            seen[base] = n + 1
            (if (n > 0) "$base#$n" else base) to b
        }
    }
    // A note above the messages when the computer sent only the newest ones.
    val headerCount = if (chat.omittedMessages > 0) 1 else 0
    val footerCount = 1
    // Adjacent calls with one purpose fold into one card (spec/chat/tool-calls-grouped-by-purpose.md).
    val rows = remember(keyed) { Purpose.group(keyed) { Purpose.role(it.second) } }
    val lastIndex = headerCount + rows.size + footerCount - 1

    // Open at the newest message, then follow the reply while it streams, unless the user scrolled up to read.
    val streamTick = (chat.blocks.lastOrNull() as? Block.Assistant)?.let { it.text.length + (it.reasoning?.length ?: 0) } ?: 0
    var openedAtBottom by remember(vm.sessionId) { mutableStateOf(false) }
    LaunchedEffect(rows.size, keyed.size, streamTick, chat.error, chat.ready) {
        if (!chat.ready || keyed.isEmpty()) return@LaunchedEffect
        if (!openedAtBottom) {
            // The list replaces the spinner in this frame: wait until it has items, then jump without animating.
            snapshotFlow { list.layoutInfo.totalItemsCount }.first { it > 0 }
            list.scrollToItem(lastIndex)
            openedAtBottom = true
            return@LaunchedEffect
        }
        val info = list.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
        val nearBottom = lastVisible >= info.totalItemsCount - 3
        if (nearBottom) list.scrollToItem(lastIndex)
    }

    // Keep the newest message in view when the list gets shorter (the keyboard opens, the message box grows),
    // if it was at the bottom; a list scrolled up to read stays where it is.
    LaunchedEffect(list) {
        var height = 0
        var atBottom = false
        snapshotFlow { list.layoutInfo.viewportSize.height to !list.canScrollForward }.collect { (h, bottom) ->
            if (h < height && atBottom) list.scrollBy((height - h).toFloat()) else atBottom = bottom
            height = h
        }
    }

    if (showChanges && changesAllowed) {
        val changes by vm.changes.collectAsStateWithLifecycle()
        ChangesSheet(
            changes.changes, changes.error, onRefresh = vm::loadChanges, onDismiss = { showChanges = false },
            onAsk = { quote -> vm.quote(quote); showChanges = false },
        )
    }

    // ⋮ → Rename, Pin, Complete, Chat mode: changes on the computer; a refusal is said in a toast.
    val chatAction: (String, suspend () -> Unit) -> Unit = { failed, action ->
        scope.launch {
            try {
                action()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                android.widget.Toast.makeText(context, e.message?.takeIf { it.isNotBlank() } ?: failed, android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    if (showRename) {
        RenameChatDialog(chat.title, onDismiss = { showRename = false }) { title ->
            showRename = false
            chatAction("Couldn’t rename this chat.") { vm.rename(title) }
        }
    }
    if (showMode) {
        ChatModeDialog(chat.mode, vm.defaultMode, computerName, onDismiss = { showMode = false }) { mode ->
            showMode = false
            scope.launch {
                try {
                    vm.setMode(mode)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if ((e as? RelayException)?.refusal?.asksForStepUp == true) {
                        modeStepUp = PendingStepUp("Switch this chat on $computerName to ${modeTitle(mode)}") { proof -> vm.setMode(mode, proof) }
                    } else {
                        android.widget.Toast.makeText(context, e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t change this chat’s mode.", android.widget.Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }
    modeStepUp?.let { pending ->
        StepUpSheet(vm.repo, pending, onDone = { modeStepUp = null }, onDismiss = { modeStepUp = null })
    }

    if (showModelEffort) {
        ModelEffortSheet(chat, computers, onSet = vm::setOptions, onLoadModels = { vm.loadModels() }, onDismiss = { showModelEffort = false })
    }
    if (showMonitor && expert) {
        MonitorSheet(hardware, chat, computerName, vm::modelName, onUnload = vm.hardware::unload, onDismiss = { showMonitor = false })
    }
    val terminals by vm.terminalsOpen.collectAsStateWithLifecycle()
    terminals?.let { t ->
        val online by vm.online.collectAsStateWithLifecycle()
        TerminalsDialog(t, online, vm.computerName, onDismiss = vm::closeTerminals)
    }
    val preview by vm.previewOpen.collectAsStateWithLifecycle()
    preview?.let { o -> PreviewWindow(o.link, vm.sessionId, vm.repo.previews, onDismiss = vm::closePreview) }
    val files by vm.filesOpen.collectAsStateWithLifecycle()
    files?.let { f -> FilesDialog(f, vm.repo, onDismiss = vm::closeFiles) }
    val git by vm.gitOpen.collectAsStateWithLifecycle()
    git?.let { o -> GitDialog(o.git, onDismiss = { vm.closeGit(); prReads++ }, pr = o.pr) }
    if (showPrs) {
        PrSheet(
            prs, onDismiss = { showPrs = false; prReads++ },
            onGit = { pr -> showPrs = false; vm.openGit(pr) },
            onAsk = { text -> vm.send(text) },
        )
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            Column {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                    actions = {
                        if (changesAllowed) {
                            IconButton(onClick = { vm.loadChanges(); showChanges = true }) {
                                Icon(Icons.Filled.Difference, contentDescription = "Changes")
                            }
                        }
                        Box {
                            IconButton(onClick = { showMenu = true }, modifier = Modifier.testTag("chat.more")) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Git") },
                                    leadingIcon = { Icon(Icons.Filled.AccountTree, contentDescription = null) },
                                    onClick = { showMenu = false; vm.openGit() },
                                    enabled = chat.savedAt == null,
                                    modifier = Modifier.testTag("chat.git"),
                                )
                                DropdownMenuItem(
                                    text = { Text("Files") },
                                    leadingIcon = { Icon(Icons.Filled.FolderOpen, contentDescription = null) },
                                    onClick = { showMenu = false; vm.openFiles() },
                                    enabled = chat.savedAt == null,
                                    modifier = Modifier.testTag("chat.files"),
                                )
                                DropdownMenuItem(
                                    text = { Text("Terminals") },
                                    leadingIcon = { Icon(Icons.Filled.Terminal, contentDescription = null) },
                                    onClick = { showMenu = false; vm.openTerminals() },
                                    enabled = chat.savedAt == null,
                                    modifier = Modifier.testTag("chat.terminals"),
                                )
                                HorizontalDivider()
                                DropdownMenuItem(
                                    text = { Text("Chat mode") },
                                    leadingIcon = { Icon(Icons.Filled.Shield, contentDescription = null) },
                                    onClick = { showMenu = false; showMode = true },
                                    enabled = online,
                                    modifier = Modifier.testTag("chat.toolMode"),
                                )
                                DropdownMenuItem(
                                    text = { Text("Rename") },
                                    leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                                    onClick = { showMenu = false; showRename = true },
                                    enabled = online,
                                    modifier = Modifier.testTag("chat.rename"),
                                )
                                DropdownMenuItem(
                                    text = { Text(if (pinned) "Unpin" else "Pin") },
                                    leadingIcon = { Icon(Icons.Filled.PushPin, contentDescription = null) },
                                    onClick = { showMenu = false; chatAction("Couldn’t change this chat.") { vm.setPinned(!pinned) } },
                                    enabled = online,
                                    modifier = Modifier.testTag("chat.pin"),
                                )
                                if (completedAt == null) {
                                    DropdownMenuItem(
                                        text = { Text("Complete") },
                                        leadingIcon = { Icon(Icons.Filled.CheckCircle, contentDescription = null) },
                                        onClick = { showMenu = false; chatAction("Couldn’t complete this chat.") { vm.complete() } },
                                        enabled = online,
                                        modifier = Modifier.testTag("chat.complete"),
                                    )
                                }
                            }
                        }
                        pane?.actions?.invoke(this)
                    },
                    navigationIcon = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                            }
                            ModeToggle(expert, vm::setExpert, compact = pane != null)
                        }
                    },
                    title = {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                // In a pane: the status dot, pulsing for a pending approval or question while the other pane has the keyboard.
                                if (pane != null) {
                                    PaneStatusDot(waiting = chat.approval != null || chat.question != null, running = chat.running, pulse = !pane.focused)
                                }
                                Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Icon(Icons.Filled.Computer, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(12.dp))
                                Text(
                                    chat.subtitle,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.inkFaint,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    },
                )
                if (expert) MonitorStrip(hardware, computerName, onOpen = { showMonitor = true }, modifier = Modifier.background(p.paper))
            }
        },
    ) { padding ->
        val transcript: @Composable (Modifier) -> Unit = { transcriptModifier ->
            Box(transcriptModifier) {
                when {
                    !chat.ready -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                    keyed.isEmpty() && chat.error == null -> Text(
                        "Ask your computer to do something. It can use its folders, tools and models.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = p.inkSoft,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp, vertical = 32.dp),
                    )
                    else -> LazyColumn(
                        state = list,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (chat.omittedMessages > 0) {
                            item(key = "omitted") {
                                Text(
                                    if (chat.omittedMessages == 1) "1 earlier message is on the computer."
                                    else "${chat.omittedMessages} earlier messages are on the computer.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.inkFaint,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                )
                            }
                        }
                        itemsIndexed(rows, key = { _, run -> rowKey(run) }) { _, run ->
                            // Watch chips and subagent rows read the chat's watches and child chats.
                            CompositionLocalProvider(LocalAgentContext provides agentContext) {
                                when (run) {
                                    is PurposeRun.Single -> {
                                        val block = run.item.second
                                        // Long press: Copy, and fork the chat from a saved message.
                                        val fork = forkAction(block)
                                        // In a pane a message can be dragged into the other pane's message box.
                                        // A reply's links to files and loopback pages open previews from the computer (AN-35).
                                        CompositionLocalProvider(LocalChatPreviews provides vm.previews) {
                                            if (pane == null) BlockView(block, fork) else Box(Modifier.messageDragSource(block, vm.sessionId)) { BlockView(block, fork) }
                                        }
                                    }
                                    is PurposeRun.Group -> {
                                        val blocks = run.items.map { it.second }
                                        // Consecutive delegations read as one group, as on the desktop.
                                        if (allSubagents(blocks)) SubagentGroup(blocks.filterIsInstance<Block.Tool>(), agentContext)
                                        else PurposeGroupCard(run.purpose, blocks, run.calls)
                                    }
                                }
                            }
                        }
                        item(key = "footer") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                chat.error?.let { Notice(it, Tone.DANGER) }
                                val rate = chat.rate
                                if (!chat.running && rate != null) {
                                    Text(
                                        String.format(Locale.US, "%.1f tokens/s", rate),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = p.inkFaint,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        val controls: @Composable () -> Unit = {
            chat.approval?.let { ApprovalCard(it, onDecide = vm::approve) }
            chat.question?.let { QuestionCard(it, onAnswer = vm::answer) }
            prs.firstOrNull()?.let { pr -> PrChip(pr) { showPrs = true } }
            // A completed chat reads like the desktop's: no message box until it is restored.
            if (completedAt != null && !chat.running) CompletedBar(
                restoring = restoring,
                error = restoreError,
                onRestore = {
                    restoring = true
                    restoreError = null
                    scope.launch {
                        try {
                            vm.restore()
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            restoreError = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t restore this chat."
                        } finally {
                            restoring = false
                        }
                    }
                },
                modifier = Modifier.navigationBarsPadding(),
            ) else Column(Modifier.navigationBarsPadding()) {
                val waiting by vm.waiting.collectAsStateWithLifecycle()
                val sendingId by vm.sendingId.collectAsStateWithLifecycle()
                val refusal by vm.refusal.collectAsStateWithLifecycle()
                val restore by vm.restore.collectAsStateWithLifecycle()
                Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    // The phone's saved copy (OF-5): read-only until the computer answers.
                    chat.savedAt?.let { at ->
                        Text(
                            savedCopyNote(at, computerName),
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkSoft,
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp).testTag("chat.savedCopy"),
                        )
                    }
                    WaitingList(waiting, sendingId, online, onEdit = vm::editWaiting, onDelete = vm::deleteWaiting, onSendNow = vm::sendWaitingNow)
                    refusal?.let { RefusalNote(it, onDismiss = vm::dismissRefusal) }
                }
                Composer(
                    restore = restore,
                    onRestored = vm::restored,
                    sendsLater = chat.sendsLater,
                    // A fork's prompt, else what was typed here last time (the saved draft).
                    initialText = initialDraft ?: vm.savedDraft.text.ifEmpty { null },
                    initialSkillName = vm.savedDraft.skill?.name.takeIf { initialDraft == null },
                    onDraftChange = vm::draftChanged,
                    running = chat.running,
                    blocked = chat.blocked,
                    queued = chat.queued,
                    onSend = { text, skill, images -> vm.send(text, skill, images) },
                    onStop = vm::stop,
                    // In a pane, text dragged from the other pane lands here (never sent by itself).
                    modifier = if (pane == null) Modifier else Modifier.messageDropTarget(vm.sessionId, vm::quote),
                    mic = mic,
                    skills = chat.skills,
                    insert = insert,
                    onInserted = vm::inserted,
                    attach = attach,
                    prompts = prompts,
                    queuedPrompts = chat.queuedPrompts,
                    onEditQueued = vm::editQueued,
                    onNewAgent = onNewChat,
                    onTerminal = vm::openTerminals,
                )
                ChatOptionsRow(chat, enabled = online, onOpenModelEffort = { showModelEffort = true })
            }
        }
        ChatColumns(top = padding.calculateTopPadding(), tabletop = pane?.tabletop, transcript = transcript, controls = controls)
    }
}

/** A chat pane's status dot: waiting on the owner (pulsing while the other pane has the keyboard), working, or idle (none). */
@Composable
private fun PaneStatusDot(waiting: Boolean, running: Boolean, pulse: Boolean) {
    if (!waiting && !running) return
    val alpha = if (waiting && pulse) {
        val t = rememberInfiniteTransition(label = "pane-dot")
        t.animateFloat(1f, 0.3f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pane-dot-alpha").value
    } else {
        1f
    }
    Dot(if (waiting) Tone.WARNING else Tone.ACCENT, Modifier.alpha(alpha))
}

/** What a dragged message carries: its text, as plain text another pane's message box takes. */
internal fun dragText(block: Block): String = when (block) {
    is Block.User -> block.text
    is Block.Assistant -> block.text
    is Block.Tool -> block.label
}

/**
 * Long-press a message in a pane and drag it: its text goes as plain text. The
 * chat's id rides along as the local state, so dropping on its own pane does nothing.
 */
@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.messageDragSource(block: Block, sessionId: String): Modifier = dragAndDropSource { _ ->
    val text = dragText(block)
    if (text.isBlank()) null else DragAndDropTransferData(ClipData.newPlainText("Message", text), localState = sessionId)
}

/**
 * The message box as a drop target for text dragged from the other pane: the text is
 * added after what is typed ([ChatViewModel.quote]) and never sent by a drop.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Modifier.messageDropTarget(sessionId: String, onText: (String) -> Unit): Modifier {
    val current by rememberUpdatedState(onText)
    val target = remember(sessionId) {
        object : DragAndDropTarget {
            override fun onDrop(event: DragAndDropEvent): Boolean {
                val drag = event.toAndroidDragEvent()
                if (drag.localState == sessionId) return false
                val clip = drag.clipData ?: return false
                val text = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).text?.toString() }.joinToString("\n").trim()
                if (text.isEmpty()) return false
                current(text)
                return true
            }
        }
    }
    return dragAndDropTarget(
        shouldStartDragAndDrop = { e -> e.mimeTypes().any { it == ClipDescription.MIMETYPE_TEXT_PLAIN || it.startsWith("text/") } },
        target = target,
    )
}

/** In place of the message box for a completed chat: say so, and offer Restore. */
@Composable
private fun CompletedBar(restoring: Boolean, error: String?, onRestore: () -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Column(
        modifier.fillMaxWidth().background(p.surface).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        error?.let { Notice(it, Tone.DANGER) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = p.success, modifier = Modifier.size(16.dp))
            Text(
                "This chat is completed. Restore it to keep going.",
                style = MaterialTheme.typography.bodyMedium,
                color = p.inkSoft,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = onRestore, enabled = !restoring) { Text(if (restoring) "Restoring…" else "Restore") }
        }
    }
}

/**
 * The composer's microphone: asks for RECORD_AUDIO the first time it is
 * tapped (Android shows its own prompt), then starts or stops dictation.
 */
@Composable
private fun rememberMic(d: DictationController?): MicUi? {
    if (d == null) return null
    val context = LocalContext.current
    val state by d.state.collectAsStateWithLifecycle()
    val error by d.error.collectAsStateWithLifecycle()
    var pending by remember { mutableStateOf<((String) -> Unit)?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val onText = pending
        pending = null
        if (granted && onText != null) d.toggle(onText)
        else if (!granted) d.denied()
    }
    // Leaving the chat drops a recording in progress; nothing is kept.
    DisposableEffect(d) { onDispose { d.cancel() } }
    return MicUi(state, error, d.computerName()) { onText ->
        val has = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (has) d.toggle(onText) else {
            pending = onText
            ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/**
 * The **+** menu's photos: the system photo picker (no storage permission) and
 * the phone's camera app writing one shot into the cache through a
 * FileProvider (no CAMERA permission). The shot is deleted once it is read;
 * photos only ever live in memory. Both trips out of the app are announced to
 * the app lock, so coming back doesn't ask to unlock.
 */
@Composable
private fun rememberAttach(vm: ChatViewModel): AttachUi {
    val context = LocalContext.current
    val lock = LocalAppLock.current
    val state by vm.photos.state.collectAsStateWithLifecycle()
    // Where the camera app was asked to write; survives the activity being recreated meanwhile.
    var shot by rememberSaveable { mutableStateOf<String?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PhotoTray.MAX_PHOTOS)) { uris ->
        lock?.returned()
        vm.addPhotos(context.contentResolver, uris)
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        lock?.returned()
        val path = shot ?: return@rememberLauncherForActivityResult
        shot = null
        val file = File(path)
        if (ok && file.length() > 0) {
            vm.addPhotos(context.contentResolver, listOf(cameraUri(context, file))) { file.delete() }
        } else {
            file.delete()
        }
    }
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    return AttachUi(
        state = state,
        onPickFiles = {
            lock?.expectReturn()
            pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        onTakePhoto = if (!hasCamera) null else {
            {
                val dir = File(context.cacheDir, "camera").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() } // a shot left by an interrupted trip
                val file = File(dir, "shot-${System.currentTimeMillis()}.jpg")
                shot = file.path
                lock?.expectReturn()
                try {
                    camera.launch(cameraUri(context, file))
                } catch (_: ActivityNotFoundException) {
                    lock?.returned()
                    shot = null
                    vm.photos.begin(1)
                    vm.photos.failed("No camera app on this phone.")
                }
            }
        },
        onRemove = vm.photos::remove,
        take = vm.photos::take,
        restore = vm.photos::restore,
        clearError = vm.photos::clearError,
    )
}

private fun cameraUri(context: Context, file: File): Uri =
    FileProvider.getUriForFile(context, "${context.packageName}.photos", file)

/** A list key for a transcript row: the block's own key, or its first block's for a purpose group. */
private fun rowKey(run: PurposeRun<Pair<String, Block>>): String = when (run) {
    is PurposeRun.Single -> run.item.first
    is PurposeRun.Group -> "purpose:" + run.items.first().first
}
