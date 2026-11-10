package com.nekko.android.ui.screens

import androidx.compose.ui.res.stringResource
import com.nekko.android.R
import com.nekko.android.voice.DictationController
import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.core.content.FileProvider
import com.nekko.android.chat.PhotoTray
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.lock.AppLock
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import com.nekko.android.ui.chat.AttachUi
import java.io.File
import com.nekko.android.ui.chat.MicUi
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
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
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.collect
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
import com.nekko.android.ui.chat.AuditSheet
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.gestures.animateScrollBy
import kotlinx.coroutines.delay
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.chat.ChatController
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
import com.nekko.android.ui.chat.StarAskCard
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Block
import com.nekko.protocol.Purpose
import com.nekko.protocol.ReplyTopics
import com.nekko.protocol.PurposeRun
import com.nekko.android.chat.TurnSteps
import com.nekko.android.ui.chat.StepsLine
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
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.simple.SimpleView
import com.nekko.android.data.SimpleMode
import com.nekko.android.ui.chat.ModelEffortSheet
import com.nekko.android.ui.chat.AgentDetails
import com.nekko.android.ui.chat.LongChatNudge
import com.nekko.android.ui.chat.MiniMonitor
import com.nekko.android.ui.simple.PollHardware
import com.nekko.android.ui.simple.ModePill
import com.nekko.android.ui.simple.rememberModePill
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import com.nekko.android.data.ModelPick
import com.nekko.android.data.SimpleVisibility
import androidx.compose.material3.CenterAlignedTopAppBar
import com.nekko.protocol.RelayState
import com.nekko.protocol.ENGINE_PROVIDER_ID
import com.nekko.protocol.RelayException
import com.nekko.android.ui.chat.ChatModeDialog
import com.nekko.android.ui.chat.WaitingList
import com.nekko.android.ui.chat.RefusalNote
import com.nekko.android.ui.chat.RenameChatDialog
import com.nekko.android.ui.security.PendingStepUp
import com.nekko.android.ui.security.StepUpSheet
import com.nekko.android.ui.settings.modeTitleRes
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Policy
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Shield

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
    /** Simple's "chat getting long" line → New chat on this computer with [ModelPick] (the chat's model) chosen. */
    onStartFresh: ((ModelPick?) -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
) {
    // Simple or Expert and the per-control choices, read from the chat's own prefs so the screen works outside the app's provider;
    // a model loaded on the computer's Model Server brings the monitors into Simple too.
    val expert by vm.expert.collectAsStateWithLifecycle()
    val raw by vm.simpleChoices.collectAsStateWithLifecycle()
    val hardware by vm.hardware.state.collectAsStateWithLifecycle()
    val pill by vm.pillPlace.collectAsStateWithLifecycle()
    val loaded = hardware.localModelLoaded
    val simple = remember(expert, raw, loaded, pill) { SimpleView(expert, SimpleMode.parse(raw), loaded, pill, vm::setPillPlace, vm::setExpert) }
    CompositionLocalProvider(LocalSimple provides simple) {
        ChatScreenContent(vm, initialDraft, dictationOn, onBack, onOpenChat, pane, onNewChat, onStartFresh, onSettings)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreenContent(
    vm: ChatViewModel,
    initialDraft: String?,
    dictationOn: Boolean,
    onBack: () -> Unit,
    onOpenChat: (id: String, draft: String?) -> Unit,
    pane: PaneSlot?,
    onNewChat: (() -> Unit)?,
    onStartFresh: ((ModelPick?) -> Unit)?,
    onSettings: (() -> Unit)?,
) {
    val simple = LocalSimple.current
    val showHardware = simple.shown("hardware")
    val showSteps = simple.shown("thinking")
    val showGit = simple.shown("ph-git")
    val chat by vm.ui.collectAsStateWithLifecycle()
    val watches by vm.watches.collectAsStateWithLifecycle()
    val subagents by vm.subagents.collectAsStateWithLifecycle()
    val agentContext = AgentContext(watches, subagents.children, subagents.activity, chat.running, chat.modelId)
    val completedAt by vm.completedAt.collectAsStateWithLifecycle()
    val starCard by vm.starCard.collectAsStateWithLifecycle()
    val changesAllowed by vm.changesAllowed.collectAsStateWithLifecycle()
    val insert by vm.insert.collectAsStateWithLifecycle()
    var showChanges by remember { mutableStateOf(false) }
    var showAudit by remember { mutableStateOf(false) }
    val auditLoad by vm.audit.collectAsStateWithLifecycle()
    // Read with the chat and after each turn: Changes shows only with something in it.
    // A short turn can start and end between two frames, so `running` alone may never appear to change.
    LaunchedEffect(vm.sessionId, chat.running, chat.blocks.size, changesAllowed) { if (changesAllowed && !chat.running) vm.loadChanges() }
    val changesLoad by vm.changes.collectAsStateWithLifecycle()
    val changedFiles = changesLoad.changes?.let { it.files.size + it.omittedFiles } ?: 0
    val hardware by vm.hardware.state.collectAsStateWithLifecycle()
    val computers by vm.computers.collectAsStateWithLifecycle()
    val computerName = computers.active?.name ?: stringResource(R.string.chats_your_computer)
    var showModelEffort by remember { mutableStateOf(false) }
    var showImageSettings by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    val pill = rememberModePill { !list.canScrollBackward }
    // The top bar's bottom and the message box's top (root coordinates): the pill moves between them.
    var barBottom by remember { mutableFloatStateOf(0f) }
    var floor by remember { mutableStateOf<Float?>(null) }
    val online = computers.conn == RelayState.ONLINE
    // The model's name for the row under the message box (the computer's list, cached for the connection).
    LaunchedEffect(chat.providerId, online) { if (online) chat.providerId?.let { vm.loadModels(it) } }
    // The Monitor names loaded models from the Model Server's own list.
    LaunchedEffect(pill.expanded, online) { if (pill.expanded && online) vm.loadModels(ENGINE_PROVIDER_ID) }
    // The minimal monitor re-reads every 3 s while it shows; Simple otherwise asks the Model Server every 10 s
    // whether a local model is loaded (which brings the monitor in).
    PollHardware(vm.hardware, online, full = showHardware, light = simple.visibility("hardware") == SimpleVisibility.AUTO)
    // Simple's "chat getting long" line, until dismissed for this chat.
    var longChatDismissed by rememberSaveable(vm.sessionId) { mutableStateOf(false) }
    val savings = chat.context?.let { c -> SimpleMode.freshSavings(chat.contextTokens ?: c.usedTokens, c.contextWindow, c.sources) }
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
    var showVoiceConversation by remember(vm) { mutableStateOf(false) }
    val focused by rememberUpdatedState(pane?.focused != false && !showMenu && !showRename && !showMode &&
        !showChanges && !showAudit && !showPrs && !showModelEffort && !showImageSettings && modeStepUp == null)
    val voiceComputer = remember(vm) { vm.repo.state.value.activeId }
    // The mic's words go through the chat's voice commands (installed by ChatVoiceControls).
    val dictationCommands = remember(vm) { com.nekko.android.voice.DictationCommands() }
    val mic = rememberMic(vm.dictation.takeIf { dictationOn }, vm.computers, dictationCommands) {
        vm.voiceEnabled && focused && voiceComputer != null && vm.repo.state.value.activeId == voiceComputer &&
            vm.repo.state.value.conn == com.nekko.protocol.RelayState.ONLINE && vm.completedAt.value == null && vm.repo.overlays.value[vm.sessionId] == null
    }
    val attach = rememberAttach(vm)
    val prompts by vm.prompts.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val res = LocalResources.current
    // The notification's "Always allow this tool": taken once the app is unlocked and this
    // chat's card shows that very call; the card then presses its own Always allow.
    val alwaysLink = (context.applicationContext as? com.nekko.android.NekkoApp)?.alwaysAllow
    val alwaysWanted = alwaysLink?.request?.collectAsStateWithLifecycle()?.value
    val lockStatus = LocalAppLock.current?.status?.collectAsStateWithLifecycle()?.value
    var alwaysNow by remember(vm.sessionId) { mutableStateOf<String?>(null) }
    LaunchedEffect(vm.sessionId, alwaysWanted, lockStatus?.locked, chat.approval?.call?.id) {
        val a = chat.approval ?: return@LaunchedEffect
        if (ChatController.offersToolScope(a.call.name) && alwaysLink?.take(vm.sessionId, a.call.id, locked = lockStatus?.locked == true) == true) {
            alwaysNow = a.call.id
        }
    }
    val editInNewChat = stringResource(R.string.chats_edit_in_new_chat)
    val forkFromHere = stringResource(R.string.chats_fork_from_here)
    // Fork the chat from a saved message: a prompt goes back into the new chat's box, a reply keeps
    // everything up to the next prompt. Streaming blocks aren't saved yet, so they offer Copy only.
    val forkAction: (Block) -> ForkAction? = { block ->
        if ((block is Block.User || (block is Block.Assistant && !block.streaming)) && vm.canFork(block)) {
            ForkAction(if (block is Block.User) editInNewChat else forkFromHere) {
                scope.launch {
                    try {
                        val (id, draft) = vm.fork(block)
                        onOpenChat(id, draft)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        android.widget.Toast.makeText(context, e.message ?: res.getString(R.string.chats_fork_failed), android.widget.Toast.LENGTH_LONG).show()
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
    // Simple folds each turn's reasoning and tool steps into one line that opens in place (the approval card still asks).
    var openTurns by remember(vm.sessionId) { mutableStateOf(setOf<String>()) }
    val rows = remember(keyed, showSteps, chat.running, openTurns) { transcriptRows(keyed, showSteps, chat.running, openTurns) }
    // How each reply reads in its turn: a note, something left for you, or the reply (spec/chat/thinking-and-replies.md).
    val voices = remember(keyed, chat.running) { keyed.map { it.first }.zip(ReplyTopics.voices(chat.blocks, chat.running)).toMap() }
    val lastIndex = headerCount + rows.size + footerCount - 1

    // Open at the newest message, then follow the reply while it streams, unless the user scrolled up to read.
    val streamTick = (chat.blocks.lastOrNull() as? Block.Assistant)?.let { it.text.length + (it.reasoning?.length ?: 0) } ?: 0
    var openedAtBottom by remember(vm.sessionId) { mutableStateOf(false) }
    LaunchedEffect(rows.size, keyed.size, streamTick, chat.error, chat.ready) {
        if (!chat.ready || keyed.isEmpty()) return@LaunchedEffect
        if (!openedAtBottom) {
            // The list replaces the spinner in this frame. Its first layout can notify snapshotFlow
            // while measurement is still running: request the jump for the next measure instead of
            // forcing a reentrant measure through scrollToItem.
            snapshotFlow { list.layoutInfo.totalItemsCount }.first { it > 0 }
            list.requestScrollToItem(lastIndex)
            openedAtBottom = true
            return@LaunchedEffect
        }
        val info = list.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
        val nearBottom = lastVisible >= info.totalItemsCount - 3
        if (nearBottom) list.scrollToItem(lastIndex)
    }

    // The GitHub star card opens under the last reply: if that reply's end is in view, bring the whole card up after it expands.
    LaunchedEffect(starCard) {
        if (starCard == ChatViewModel.StarCard.NONE) return@LaunchedEffect
        val before = list.layoutInfo
        if ((before.visibleItemsInfo.lastOrNull()?.index ?: -1) < before.totalItemsCount - 1) return@LaunchedEffect
        delay(220)
        val info = list.layoutInfo
        val last = info.visibleItemsInfo.lastOrNull()?.takeIf { it.index == info.totalItemsCount - 1 } ?: return@LaunchedEffect
        val hidden = last.offset + last.size + info.afterContentPadding - info.viewportEndOffset
        if (hidden > 0) list.animateScrollBy(hidden.toFloat(), tween(200))
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
        ChangesSheet(
            changesLoad.changes, changesLoad.error, onRefresh = vm::loadChanges, onDismiss = { showChanges = false },
            onAsk = { quote -> vm.quote(quote); showChanges = false },
        )
    }

    if (showAudit) {
        AuditSheet(auditLoad.trail, auditLoad.error, onRefresh = vm::loadAudit, onDismiss = { showAudit = false })
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
            chatAction(res.getString(R.string.chats_rename_this_failed)) { vm.rename(title) }
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
                        modeStepUp = PendingStepUp(res.getString(R.string.chats_mode_step_up, computerName, res.getString(modeTitleRes(mode)))) { proof -> vm.setMode(mode, proof) }
                    } else {
                        android.widget.Toast.makeText(context, e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.chats_mode_failed), android.widget.Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }
    modeStepUp?.let { pending ->
        StepUpSheet(vm.repo, pending, onDone = { modeStepUp = null }, onDismiss = { modeStepUp = null })
    }

    if (showImageSettings) {
        com.nekko.android.ui.chat.ImageChatSettingsSheet(
            chat.imageParams ?: com.nekko.protocol.ImageChatParams(),
            enabled = online && !chat.running && computers.imageGeneration,
            loadModels = vm::imageModels, onSave = vm::setImageParams,
            onDismiss = { showImageSettings = false },
        )
    }
    if (showModelEffort) {
        ModelEffortSheet(chat, computers, onSet = vm::setOptions, onLoadModels = { vm.loadModels() }, onRunOption = vm::setRunOption, onLoadTools = vm::tools, onSetTool = { name, on -> vm.setTool(name, on, chat.disabledTools) }, onDismiss = { showModelEffort = false })
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

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = p.paper,
            topBar = {
                Column(Modifier.onGloballyPositioned { barBottom = it.boundsInRoot().bottom }) {
                    CenterAlignedTopAppBar(
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                        // A little shorter than the default, so the mode pill sits right under the title.
                        expandedHeight = 56.dp,
                        actions = {
                            if (changesAllowed && simple.shown("changes", changes = changedFiles > 0)) {
                                val filesChanged = if (changedFiles == 1) stringResource(R.string.simple_files_changed_one) else stringResource(R.string.simple_files_changed_other, changedFiles)
                                IconButton(onClick = { vm.loadChanges(); showChanges = true }, modifier = Modifier.testTag("chat.changes")) {
                                    BadgedBox(badge = { Badge(containerColor = p.accent, contentColor = p.accentInk) { Text("$changedFiles") } }) {
                                        Icon(Icons.Filled.Difference, contentDescription = filesChanged)
                                    }
                                }
                            }
                            Box {
                                IconButton(onClick = { showMenu = true }, modifier = Modifier.testTag("chat.more")) {
                                    Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.chats_more))
                                }
                                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                                    if (showGit) DropdownMenuItem(
                                        text = { Text("Git") },
                                        leadingIcon = { Icon(Icons.Filled.AccountTree, contentDescription = null) },
                                        onClick = { showMenu = false; vm.openGit() },
                                        enabled = chat.savedAt == null,
                                        modifier = Modifier.testTag("chat.git"),
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.chats_files)) },
                                        leadingIcon = { Icon(Icons.Filled.FolderOpen, contentDescription = null) },
                                        onClick = { showMenu = false; vm.openFiles() },
                                        enabled = chat.savedAt == null,
                                        modifier = Modifier.testTag("chat.files"),
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.chats_terminals)) },
                                        leadingIcon = { Icon(Icons.Filled.Terminal, contentDescription = null) },
                                        onClick = { showMenu = false; vm.openTerminals() },
                                        enabled = chat.savedAt == null,
                                        modifier = Modifier.testTag("chat.terminals"),
                                    )
                                    HorizontalDivider()
                                    if (simple.expert && simple.shown("asks")) DropdownMenuItem(
                                        text = { Text(stringResource(R.string.chats_chat_mode)) },
                                        leadingIcon = { Icon(Icons.Filled.Shield, contentDescription = null) },
                                        onClick = { showMenu = false; showMode = true },
                                        enabled = online,
                                        modifier = Modifier.testTag("chat.toolMode"),
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.chat_audit_trail)) },
                                        leadingIcon = { Icon(Icons.Filled.Policy, contentDescription = null) },
                                        onClick = { showMenu = false; vm.loadAudit(); showAudit = true },
                                        enabled = online,
                                        modifier = Modifier.testTag("chat.audit"),
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.chats_rename)) },
                                        leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                                        onClick = { showMenu = false; showRename = true },
                                        enabled = online,
                                        modifier = Modifier.testTag("chat.rename"),
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(if (pinned) R.string.chats_unpin else R.string.chats_pin)) },
                                        leadingIcon = { Icon(Icons.Filled.PushPin, contentDescription = null) },
                                        onClick = { showMenu = false; chatAction(res.getString(R.string.chats_change_this_failed)) { vm.setPinned(!pinned) } },
                                        enabled = online,
                                        modifier = Modifier.testTag("chat.pin"),
                                    )
                                    if (completedAt == null) {
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.chats_complete)) },
                                            leadingIcon = { Icon(Icons.Filled.CheckCircle, contentDescription = null) },
                                            onClick = { showMenu = false; chatAction(res.getString(R.string.chats_complete_this_failed)) { vm.complete() } },
                                            enabled = online,
                                            modifier = Modifier.testTag("chat.complete"),
                                        )
                                    }
                                }
                            }
                            pane?.actions?.invoke(this)
                        },
                        navigationIcon = {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chats_back))
                            }
                        },
                        title = {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    // In a pane: the status dot, pulsing for a pending approval or question while the other pane has the keyboard.
                                    if (pane != null) {
                                        PaneStatusDot(waiting = chat.approval != null || chat.question != null, running = chat.running, pulse = !pane.focused)
                                    }
                                    Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                if (simple.shown("ph-subtitle")) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
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
                }
            },
        ) { padding ->
            val transcript: @Composable (Modifier) -> Unit = { transcriptModifier ->
                Box(transcriptModifier.onGloballyPositioned { floor = it.boundsInRoot().bottom }) {
                    when {
                        !chat.ready -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                        keyed.isEmpty() && chat.error == null -> Text(
                            stringResource(R.string.chats_chat_empty),
                            style = MaterialTheme.typography.bodyLarge,
                            color = p.inkSoft,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp, vertical = 32.dp),
                        )
                        else -> LazyColumn(
                            state = list,
                            modifier = Modifier.fillMaxSize().nestedScroll(pill.scroll),
                            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp, top = pill.topInset(simple.pill, otherwise = 16.dp)),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            if (chat.omittedMessages > 0) {
                                item(key = "omitted") {
                                    Text(
                                        if (chat.omittedMessages == 1) stringResource(R.string.chats_omitted_one)
                                        else stringResource(R.string.chats_omitted_other, chat.omittedMessages),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = p.inkFaint,
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    )
                                }
                            }
                            itemsIndexed(rows, key = { _, row -> rowKey(row) }) { _, row ->
                                val run = (row as? TranscriptRow.Run)?.run
                                // Watch chips and subagent rows read the chat's watches and child chats.
                                CompositionLocalProvider(LocalAgentContext provides agentContext, com.nekko.android.ui.chat.LocalSessionPhoto provides vm::photo) {
                                    when {
                                        row is TranscriptRow.Steps -> StepsLine(row.steps.steps, row.steps.running, row.steps.durationMs, row.steps.open) {
                                            openTurns = if (row.steps.open) openTurns - row.steps.turn else openTurns + row.steps.turn
                                        }
                                        run is PurposeRun.Single -> {
                                            val block = run.item.second
                                            // Long press: Copy, and fork the chat from a saved message.
                                            val fork = forkAction(block)
                                            // In a pane a message can be dragged into the other pane's message box.
                                            // A reply's links to files and loopback pages open previews from the computer (AN-35).
                                            CompositionLocalProvider(LocalChatPreviews provides vm.previews) {
                                                val reasoning = (row as TranscriptRow.Run).stepsOpen
                                                val voice = voices[run.item.first]
                                                if (pane == null) BlockView(block, fork, voice, reasoning) else Box(Modifier.messageDragSource(block, vm.sessionId)) { BlockView(block, fork, voice, reasoning) }
                                            }
                                        }
                                        run is PurposeRun.Group -> {
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
                                            stringResource(R.string.chats_tokens_per_second, String.format(Locale.US, "%.1f", rate)),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = p.inkFaint,
                                        )
                                    }
                                    // The GitHub star ask under the 10th and 50th reply, never over a question, an approval, a failure or a saved copy.
                                    val starShows = starCard != ChatViewModel.StarCard.NONE && !chat.running && chat.question == null &&
                                        chat.approval == null && chat.error == null && chat.savedAt == null && completedAt == null
                                    AnimatedVisibility(starShows, enter = fadeIn(tween(200)) + expandVertically(tween(200)), exit = fadeOut(tween(150)) + shrinkVertically(tween(150))) {
                                        StarAskCard(
                                            thanked = starCard == ChatViewModel.StarCard.THANKS,
                                            onStar = vm::starred,
                                            onLater = { vm.closeStarAsk() },
                                            onNever = { vm.closeStarAsk(forever = true) },
                                            onClose = { vm.closeStarAsk() },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            val controls: @Composable () -> Unit = {
                chat.approval?.let { a ->
                    ApprovalCard(a, onDecide = vm::approve, onAlwaysAllow = {
                        try {
                            vm.alwaysAllowTool()
                        } catch (e: RelayException) {
                            // A second factor first (SK-7): the sheet asks, then saves and allows; the card stays meanwhile.
                            if (e.refusal?.asksForStepUp != true) throw e
                            modeStepUp = PendingStepUp(res.getString(R.string.chats_tool_step_up, computerName, a.call.name)) { proof -> vm.alwaysAllowTool(proof) }
                        }
                    }, startAlways = alwaysNow == a.call.id, onStartedAlways = { alwaysNow = null })
                }
                chat.question?.let { QuestionCard(it, onAnswer = vm::answer) }
                prs.firstOrNull()?.takeIf { simple.shown("pr-status", pr = true) }?.let { pr -> PrChip(pr) { showPrs = true } }
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
                                restoreError = e.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.chats_restore_this_failed)
                            } finally {
                                restoring = false
                            }
                        }
                    },
                    modifier = Modifier.navigationBarsPadding(),
                ) else Column(Modifier.navigationBarsPadding()) {
                    if (!simple.expert && savings != null && !longChatDismissed) {
                        LongChatNudge(
                            savings,
                            onStartFresh = onStartFresh?.let { go -> { go(chat.providerId?.let { pr -> chat.modelId?.let { ModelPick(pr, it) } }) } },
                            onDismiss = { longChatDismissed = true },
                        )
                    }
                    val waiting by vm.waiting.collectAsStateWithLifecycle()
                    val sendingId by vm.sendingId.collectAsStateWithLifecycle()
                    val refusal by vm.refusal.collectAsStateWithLifecycle()
                    val restore by vm.restore.collectAsStateWithLifecycle()
                    Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        // The phone's saved copy (OF-5): read-only until the computer answers.
                        chat.savedAt?.let { at ->
                            Text(
                                savedCopyNote(at, computerName, template = stringResource(R.string.chats_saved_copy_note)),
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
                        offerSubagent = chat.offersSubagent,
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
                        skills = if (chat.chatType == "image") emptyList() else chat.skills,
                        insert = insert,
                        onInserted = vm::inserted,
                        // Keep a restored tray removable, but never offer new image attachments.
                        attach = if (chat.chatType == "image" && attach.state.photos.isEmpty()) null else attach,
                        prompts = if (chat.chatType == "image") emptyList() else prompts,
                        queuedPrompts = chat.queuedPrompts,
                        onEditQueued = vm::editQueued,
                        onInterrupt = vm::interruptQueued,
                        onNewAgent = onNewChat,
                        onTerminal = vm::openTerminals,
                        onVoiceConversation = if (dictationOn && chat.chatType != "image") ({ showVoiceConversation = true }) else null,
                        voiceControls = if (chat.chatType == "image") null else { composer ->
                            com.nekko.android.voice.ChatVoiceControls(
                                vm, dictationOn, focused, composer,
                                showVoiceConversation, { showVoiceConversation = false }, onOpenChat, onNewChat, onSettings,
                                dictation = dictationCommands,
                            )
                        },
                        footer = {
                            if (chat.chatType == "image") {
                                TextButton(onClick = { showImageSettings = true }, modifier = Modifier.testTag("image.settings")) {
                                    Text(stringResource(R.string.image_settings) + " · " + (chat.imageParams?.modelId ?: stringResource(R.string.image_model)))
                                }
                            } else ChatOptionsRow(chat, enabled = online, onOpenModelEffort = { showModelEffort = true }, asks = chat.mode ?: vm.defaultMode, onOpenAsks = { showMode = true })
                        },
                    )
                }
            }
            ChatColumns(top = padding.calculateTopPadding(), tabletop = pane?.tabletop, transcript = transcript, controls = controls)
        }
        // The mode pill floats over the chat; tapping its gauges opens the agent's details.
        ModePill(
            pill, barBottom, floor,
            gauges = if (showHardware) { vertical, open -> MiniMonitor(hardware, onOpen = open, compact = pane != null, vertical = vertical, modelName = vm::modelName) } else null,
            details = { AgentDetails(hardware, chat, computerName, vm::modelName, vm.hardware::unload, vm.hardware.actions) },
        )
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
                stringResource(R.string.chats_completed_bar),
                style = MaterialTheme.typography.bodyMedium,
                color = p.inkSoft,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = onRestore, enabled = !restoring) { Text(stringResource(if (restoring) R.string.chats_restoring else R.string.chats_restore)) }
        }
    }
}

/**
 * The composer's microphone: asks for RECORD_AUDIO the first time it is
 * tapped (Android shows its own prompt), then starts or stops dictation.
 */
@Composable
private fun rememberMic(
    d: DictationController?,
    updates: kotlinx.coroutines.flow.Flow<*>? = null,
    /** Routes the words through the chat's voice commands ("Nekko, send"); else they are typed. */
    commands: com.nekko.android.voice.DictationCommands? = null,
    authorized: () -> Boolean = { true },
): MicUi? {
    if (d == null) return null
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val lifecycle = owner.lifecycle
    val lock = LocalAppLock.current
    val scope = rememberCoroutineScope()
    val token = remember(d, owner) { Any() }
    val currentAuthorization by rememberUpdatedState(authorized)
    fun allowed() = currentAuthorization() && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && lock?.locked != true && lock?.covered?.value != true
    val state by d.state.collectAsStateWithLifecycle()
    val error by d.error.collectAsStateWithLifecycle()
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // A permission result never restarts capture. Tap the microphone again.
        if (!granted) d.denied()
    }
    val safety = remember(d, owner) { com.nekko.android.voice.VoiceSafety(context, owner) { com.nekko.android.voice.VoiceAudioOwner.release(token); d.cancel() } }
    DisposableEffect(d, lifecycle, lock, scope) {
        val dispose = observeMicLifecycle(d, lifecycle, lock, scope) { com.nekko.android.voice.VoiceAudioOwner.release(token) }
        safety.start()
        val authorityJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            updates?.collect { if (!allowed()) { com.nekko.android.voice.VoiceAudioOwner.release(token); d.cancel() } }
        }
        onDispose { authorityJob.cancel(); dispose(); safety.close(); com.nekko.android.voice.VoiceAudioOwner.release(token) }
    }
    LaunchedEffect(allowed()) { if (!allowed()) { com.nekko.android.voice.VoiceAudioOwner.release(token); d.cancel() } }
    return MicUi(state, error, d.computerName()) { onText ->
        if (allowed()) {
            val has = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (has) {
                // Tap mode (the iPhone's): listens until Stop, each pause's words as they come. Starting,
                // the chat's voice controls take the microphone so "Nekko, …" commands in the words run;
                // without them the words are typed. Stopping needs neither.
                if (d.state.value !is com.nekko.android.voice.MicState.Idle) {
                    // Stop: keep whoever holds the microphone, or taking it back would cancel and restart.
                    d.toggle(continuous = true) { }
                    return@MicUi
                }
                val sink = commands?.start()
                if (sink == null) com.nekko.android.voice.VoiceAudioOwner.claim(token) { d.cancel() }
                d.toggle(continuous = true) { words ->
                    when {
                        !allowed() -> Unit
                        sink != null -> sink(words)
                        com.nekko.android.voice.VoiceAudioOwner.owns(token) -> onText(words)
                    }
                }
            } else ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/** LockGate keeps the chat composed, so disposal alone cannot protect the microphone. */
internal fun observeMicLifecycle(
    d: DictationController,
    lifecycle: Lifecycle,
    lock: AppLock?,
    scope: CoroutineScope,
    clearPending: () -> Unit,
): () -> Unit {
    val cancel = {
        clearPending()
        d.cancel()
    }
    val observer = LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_STOP) cancel()
    }
    lifecycle.addObserver(observer)
    if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) cancel()
    // Deliberately not lifecycle-aware: locking must cancel even while the chat is stopped.
    val lockJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        lock?.status?.collect { if (it.locked) cancel() }
    }
    val coverJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        lock?.covered?.collect { if (it) cancel() }
    }
    return {
        lifecycle.removeObserver(observer)
        lockJob.cancel()
        coverJob.cancel()
        cancel()
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
    val res = LocalResources.current
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
                    vm.photos.failed(res.getString(R.string.chats_no_camera))
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

/** A transcript row: a message or a purpose group, or (Simple) one turn's folded steps. */
private sealed interface TranscriptRow {
    /** [stepsOpen] when its turn's steps show, so a reply's reasoning shows too. */
    data class Run(val run: PurposeRun<Pair<String, Block>>, val stepsOpen: Boolean) : TranscriptRow
    data class Steps(val steps: TurnSteps.Row.Summary<Pair<String, Block>>) : TranscriptRow
}

private fun transcriptRows(keyed: List<Pair<String, Block>>, showSteps: Boolean, running: Boolean, open: Set<String>): List<TranscriptRow> {
    if (showSteps) return Purpose.group(keyed) { Purpose.role(it.second) }.map { TranscriptRow.Run(it, stepsOpen = true) }
    val out = mutableListOf<TranscriptRow>()
    val pending = mutableListOf<Pair<String, Block>>()
    var pendingOpen = false
    fun flush() {
        Purpose.group(pending.toList()) { Purpose.role(it.second) }.forEach { out += TranscriptRow.Run(it, pendingOpen) }
        pending.clear()
    }
    TurnSteps.fold(keyed, { it.second }, { it.first }, running, open).forEach { r ->
        when (r) {
            is TurnSteps.Row.Summary -> { flush(); out += TranscriptRow.Steps(r) }
            is TurnSteps.Row.Item -> {
                if (r.stepsOpen != pendingOpen) flush()
                pendingOpen = r.stepsOpen
                pending += r.item
            }
        }
    }
    flush()
    return out
}

/** A list key for a transcript row: the block's own key, its first block's for a purpose group, or its turn's for folded steps. */
private fun rowKey(row: TranscriptRow): String = when (row) {
    is TranscriptRow.Steps -> "steps:" + row.steps.turn
    is TranscriptRow.Run -> when (val run = row.run) {
        is PurposeRun.Single -> run.item.first
        is PurposeRun.Group -> "purpose:" + run.items.first().first
    }
}
