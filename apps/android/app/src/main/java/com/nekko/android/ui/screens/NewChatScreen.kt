package com.nekko.android.ui.screens

import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.protocol.WorkspaceFolder
import com.nekko.android.data.NewChatSpec
import com.nekko.protocol.DraftStore
import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelPick
import com.nekko.android.data.ModelScope
import com.nekko.android.data.ModelSection
import com.nekko.android.data.ModelSections
import com.nekko.android.data.modelGroups
import com.nekko.android.ui.chat.effortLabel
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.components.ComputerIcon
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.computerIconRes
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Channels
import com.nekko.protocol.Effort
import com.nekko.protocol.LocalProviders
import com.nekko.protocol.MachinePick
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.ProviderAccounts
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.RelayState
import com.nekko.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import com.nekko.android.ui.settings.stateName
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Start a chat on the active computer: pick a model (and optionally a folder).
 * [shared] is text from another app's share sheet: shown here, editable, and put
 * in the new chat's composer; Nekko never sends it by itself.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(
    repo: ComputersRepository,
    onBack: () -> Unit,
    /** The phone's default model for the active computer (Settings → New chats), if set. */
    phonePick: ModelPick? = null,
    /** The model to open on instead (Start fresh from a long chat). */
    startPick: ModelPick? = null,
    shared: String? = null,
    onEditShared: (String) -> Unit = {},
    onPair: () -> Unit,
    onCreated: (String) -> Unit,
    /** Offline: the chat and its first message went to the outbox (*Start when online*). */
    onQueued: () -> Unit = onBack,
) {
    val c by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    val active = c.active
    val online = c.conn == RelayState.ONLINE
    var imageChat by rememberSaveable(c.activeId) { mutableStateOf(false) }
    val groups = modelGroups(c)

    var pick by rememberSaveable(stateSaver = ModelPickSaver) { mutableStateOf<ModelPick?>(null) }
    var touched by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var workspaceId by rememberSaveable { mutableStateOf<String?>(null) }
    /** How hard the model works (T201a); null follows the computer's own effort setting. */
    var effort by rememberSaveable { mutableStateOf<String?>(null) }
    /** Run on was used here, so the row stays while the other computer connects and lists its models. */
    var switched by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    /** Automatic (2026-11-05): a local-model chat starts on a free computer. Off once a computer is picked by hand. */
    var autoOn by rememberSaveable { mutableStateOf(true) }
    /** What Automatic chose last, and why (the line under Run on). */
    var autoPick by remember { mutableStateOf<MachinePick?>(null) }
    var autoFinding by remember { mutableStateOf(false) }
    /** Bumped to ask again: a local model picked, or Automatic chosen. */
    var autoRun by remember { mutableIntStateOf(0) }
    /** Automatic set the model (a local one), on a computer whose providers may still be loading. */
    var autoChoseModel by rememberSaveable { mutableStateOf(false) }

    // "Send your first prompt" (#2234): once, over someone's first ever New chat; closing it any way marks it seen.
    val prefs = com.nekko.android.ui.security.LocalPhonePrefs.current
    val introSeen = prefs?.flow(FirstPromptIntro.SEEN)?.collectAsStateWithLifecycle()?.value ?: true
    var introOpen by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(introSeen, c.summariesLoaded, c.savedListAt, online, c.summaries) {
        if (!introOpen && FirstPromptIntro.shouldShow(introSeen, listLoaded = online && c.summariesLoaded && c.savedListAt == null, chats = c.summaries)) introOpen = true
    }
    if (introOpen) FirstPromptIntroSheet(onDone = { introOpen = false; prefs?.set(FirstPromptIntro.SEEN, true) })

    // The models are the computer's: ask every enabled provider there, in parallel.
    LaunchedEffect(online, c.providers, imageChat) {
        if (online && !imageChat && c.providers.isNotEmpty()) {
            try {
                repo.loadAllModels()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Per-provider failures are in the state; a lost connection shows above.
            }
        }
    }
    // Open on the computer's default, else the model of its latest chat, until the user picks.
    // Open on the phone's default for this computer, else the computer's, else its latest chat's.
    LaunchedEffect(groups, c.defaults, c.summaries, phonePick, startPick) {
        // Until the user picks, keep following the best candidate: the lists arrive one provider
        // at a time, so the phone's model may show up after the computer's default was chosen.
        if (!touched) pick = ModelChoice.initial(c.defaults, c.summaries, groups, startPick ?: phonePick) ?: pick
    }
    val phonePickMissing = startPick == null && ModelChoice.phonePickMissing(phonePick, groups)
    // A level the chosen model doesn't take is cleared.
    LaunchedEffect(pick) {
        if (effort != null && Effort.levels(pick?.modelId).none { it.wire == effort }) effort = null
    }
    val pickedKind = c.providers.firstOrNull { it.id == pick?.providerId }?.kind
    val isLocal = LocalProviders.isLocal(pickedKind) || (autoChoseModel && pickedKind == null)
    // A local model runs on its computer's hardware: offer the other paired computers.
    val showRunOn = !imageChat && c.computers.size > 1 && (switched || isLocal)
    // Automatic can choose: a local model, other computers connected, and no folder (a folder decides the computer).
    val autoOffered = !imageChat && isLocal && workspaceId == null && c.computers.size > 1 && c.peers.isNotEmpty()
    val autoShown = autoOn && autoOffered
    // Ask every computer whether it is in use and move the chat to a free one, with a local model there.
    LaunchedEffect(autoRun, autoShown, online) {
        val chosen = pick
        if (!autoShown || !online || autoPick != null || busy || chosen == null) return@LaunchedEffect
        autoFinding = true
        try {
            val from = repo.state.value.activeId
            val result = repo.pickMachine(from)
            if (!autoOn || pick != chosen) return@LaunchedEffect
            val target = result.computerId
            if (target == null || target == from) {
                autoPick = result
                return@LaunchedEffect
            }
            val next = repo.localModel(target, listOf(chosen.providerId to chosen.modelId))
            if (next == null) {
                // It has no model to start with after all: stay, and say every other computer was busy.
                autoPick = MachinePick(from, MachinePick.Reason.ALL_BUSY)
                return@LaunchedEffect
            }
            if (!autoOn || pick != chosen || busy) return@LaunchedEffect
            // Moved by Automatic: the folder stays unset, and the model is that computer's.
            repo.connect(target)
            pick = ModelPick(next.first, next.second)
            touched = true
            autoChoseModel = true
            effort = null
            error = null
            autoPick = result
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Nothing moved: the chat starts where it is.
        } finally {
            autoFinding = false
        }
    }
    val runOn: (String) -> Unit = { id ->
        // Picking a computer by hand turns Automatic off for this chat.
        autoOn = false
        autoPick = null
        if (id != c.activeId) {
            switched = true
            // The model, folder and effort are the old computer's; the new one's defaults are picked when its models arrive.
            pick = null
            touched = false
            workspaceId = null
            effort = null
            error = null
            scope.launch {
                try {
                    repo.connect(id)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = e.message ?: res.getString(R.string.chats_connect_failed)
                }
            }
        }
    }

    val start: () -> Unit = start@{
        val chosen = pick
        if (chosen == null) {
            error = res.getString(R.string.chats_pick_model)
            return@start
        }
        val pid = chosen.providerId
        val mid = chosen.modelId
        busy = true
        error = null
        scope.launch {
            try {
                val r = repo.remote()
                val created = r.call(Channels.SESSION_CREATE, *listOfNotNull(workspaceId?.let { JsonPrimitive(it) }).toTypedArray())
                val session = Session.from(created) ?: throw IllegalStateException(res.getString(R.string.chats_not_created))
                val level = effort
                r.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(session.id), buildJsonObject {
                    put("providerId", pid)
                    put("modelId", mid)
                    if (level != null) put("effort", level)
                })
                onCreated(session.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: res.getString(R.string.chats_start_failed)
                busy = false
            }
        }
    }

    // The system Back gesture drops the share too, like the top-bar arrow.
    BackHandler(onBack = onBack)

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.chats_new_chat)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.chats_back)) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            if (shared != null) SharedTextCard(shared, onEditShared)
            SectionHeader(if (active != null) stringResource(R.string.chats_on_computer, active.name) else stringResource(R.string.chats_on_your_computer))
            Column(Modifier.padding(horizontal = 16.dp)) {
                // Chat or Image: icons only, at the top right of what you start the chat from (#2448).
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.End) {
                    com.nekko.android.ui.chat.ChatKindToggle(image = imageChat, onChange = { imageChat = it })
                }
                when {
                    active == null -> NCard {
                        Text(
                            stringResource(R.string.chats_pair_to_run),
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.inkSoft,
                        )
                        OutlinedButton(onClick = onPair, modifier = Modifier.heightIn(min = 48.dp)) {
                            Icon(Icons.Outlined.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.chats_pair_title))
                        }
                    }
                    imageChat -> NCard {
                        val canCreate = online && c.imageGeneration
                        Text(stringResource(R.string.image_prompt_only), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                        if (!online) Text(stringResource(R.string.image_offline), color = p.warning)
                        else if (!c.imageGeneration) Text(stringResource(R.string.image_unsupported), color = p.warning)
                        com.nekko.android.ui.chat.ImageChatEditor(
                            enabled = canCreate,
                            loadModels = { repo.imageModels() },
                            actionLabel = stringResource(R.string.image_create),
                            onSave = { params -> onCreated(repo.createImageChat(params)) },
                        )
                    }
                    !online -> OfflineNewChat(repo, active.name, phonePick, c.workspaces, shared, onQueued)
                    else -> NCard {
                        Label(Icons.Outlined.Memory, stringResource(R.string.chats_model_from, active.name))
                        if (phonePickMissing && !touched) {
                            Text(
                                stringResource(R.string.chats_default_missing, active.name, phonePick?.modelId.toString()),
                                style = MaterialTheme.typography.bodySmall,
                                color = p.warning,
                            )
                        }
                        ModelList(
                            groups = groups,
                            favorites = c.defaults.favoriteModels,
                            query = query,
                            onQuery = { query = it },
                            selected = pick,
                            onPick = {
                                pick = it
                                touched = true
                                autoChoseModel = false
                                error = null
                                // A local model picked: Automatic asks again.
                                if (LocalProviders.isLocal(c.providers.firstOrNull { pr -> pr.id == it.providerId }?.kind)) {
                                    autoPick = null
                                    autoRun++
                                }
                            },
                            onRetry = {
                                scope.launch {
                                    try {
                                        repo.loadAllModels(force = true)
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (_: Exception) {
                                        // Shown per provider.
                                    }
                                }
                            },
                        )
                        val chosen = pick
                        if (chosen != null && LocalSimple.current.shown("effort")) {
                            Label(Icons.Outlined.Speed, stringResource(R.string.chats_effort))
                            Row(Modifier.horizontalScroll(rememberScrollState()).testTag("newChat.effort"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Chip(stringResource(R.string.chats_computer_default), effort == null) { effort = null }
                                Effort.levels(chosen.modelId).forEach { e -> Chip(effortLabel(e), effort == e.wire) { effort = e.wire } }
                            }
                        }
                        if (c.workspaces.isNotEmpty()) {
                            Label(Icons.Outlined.Folder, stringResource(R.string.chats_folder))
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Chip(stringResource(R.string.chats_folder_none), workspaceId == null) { workspaceId = null }
                                c.workspaces.forEach { w -> Chip(w.name, w.id == workspaceId) { workspaceId = w.id } }
                            }
                        }
                        error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.danger) }
                        Button(
                            onClick = start,
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) {
                            if (busy) {
                                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp), color = p.accentInk)
                            } else {
                                Icon(Icons.Outlined.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
                            }
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.chats_start_on, active.name), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                if (showRunOn) {
                    Spacer(Modifier.size(12.dp))
                    NCard {
                        Label(Icons.Outlined.Computer, stringResource(R.string.chats_run_on))
                        Row(Modifier.horizontalScroll(rememberScrollState()).testTag("newChat.runOn"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (autoOffered) {
                                Chip(stringResource(R.string.chats_auto), autoShown) {
                                    autoOn = true
                                    autoPick = null
                                    autoRun++
                                }
                            }
                            c.computers.forEach { pc ->
                                // Every paired computer stays connected: each says whether it can take the chat now.
                                val label = if (pc.id == c.activeId || c.peers.isEmpty()) pc.name
                                else stringResource(R.string.chats_run_on_state, pc.name, stringResource(stateName(c.connOf(pc.id))))
                                Chip(label, !autoShown && pc.id == c.activeId, pc.icon) { runOn(pc.id) }
                            }
                        }
                        val name = active?.name.orEmpty()
                        val made = autoPick
                        val line = when {
                            !autoShown -> stringResource(R.string.chats_run_on_note)
                            autoFinding -> stringResource(R.string.chats_auto_finding)
                            made == null -> stringResource(R.string.chats_auto_note)
                            made.reason == MachinePick.Reason.FREE -> {
                                val busyName = made.skipped.firstOrNull()?.let { id -> c.computers.firstOrNull { it.id == id }?.name }
                                if (busyName != null) stringResource(R.string.chats_auto_free_busy, name, busyName)
                                else stringResource(R.string.chats_auto_free, name)
                            }
                            made.reason == MachinePick.Reason.ALL_BUSY -> stringResource(R.string.chats_auto_all_busy, name)
                            else -> stringResource(R.string.chats_auto_none, name)
                        }
                        Text(
                            line,
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkSoft,
                            modifier = if (autoShown) Modifier.testTag("newChat.auto") else Modifier,
                        )
                    }
                }
            }
            Spacer(Modifier.size(32.dp))
        }
    }
}

/** The shared text, editable before the chat starts. Nothing is sent from here. */
@Composable
private fun SharedTextCard(text: String, onEdit: (String) -> Unit) {
    val p = Nekko.palette
    SectionHeader(stringResource(R.string.chats_shared_with))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f)) { Label(Icons.AutoMirrored.Outlined.Notes, stringResource(R.string.chats_shared_note)) }
                IconButton(onClick = { onEdit("") }) {
                    Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.chats_remove_shared), tint = p.inkFaint)
                }
            }
            OutlinedTextField(
                value = text,
                onValueChange = onEdit,
                minLines = 2,
                maxLines = 8,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun Label(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    val p = Nekko.palette
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}

@Composable
private fun Chip(label: String, selected: Boolean, icon: String? = null, onClick: () -> Unit) {
    val p = Nekko.palette
    // Quiet choices (#2417, the iPhone's #2416): no outline and no solid fill; the chosen one is
    // tinted and named in the accent, with a check. The touch target stays at least 48 dp.
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium) },
        leadingIcon = computerIconRes(icon)?.let { { ComputerIcon(icon) } }
            ?: if (selected) ({ Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }) else null,
        border = null,
        colors = FilterChipDefaults.filterChipColors(
            containerColor = androidx.compose.ui.graphics.Color.Transparent,
            labelColor = p.ink,
            selectedContainerColor = p.accentSoft,
            selectedLabelColor = p.accent,
            selectedLeadingIconColor = p.accent,
        ),
        modifier = Modifier.heightIn(min = 48.dp),
    )
}

/**
 * Every enabled provider's models on the computer in one list, grouped by
 * provider like the desktop picker, the computer's starred models first.
 */
@Composable
internal fun ModelList(
    groups: List<ModelGroup>,
    favorites: List<String>,
    query: String,
    onQuery: (String) -> Unit,
    selected: ModelPick?,
    onPick: (ModelPick) -> Unit,
    onRetry: () -> Unit,
) {
    val p = Nekko.palette
    if (groups.isEmpty()) {
        Text(
            stringResource(R.string.chats_no_providers),
            style = MaterialTheme.typography.bodyMedium,
            color = p.inkFaint,
        )
        return
    }
    // Opens on All every time, as on the desktop and the iPhone.
    var scope by rememberSaveable { mutableStateOf(ModelScope.ALL) }
    ModelScopeTabs(scope) { scope = it }
    val total = groups.sumOf { it.models?.size ?: 0 }
    if (total > 8 || query.isNotEmpty()) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            placeholder = { Text(stringResource(R.string.chats_search_models)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            modifier = Modifier.fillMaxWidth(),
        )
    }
    val inScope = scope.groups(groups)
    val shown = ModelChoice.filter(inScope, query)
    val starred = if (query.isBlank()) ModelChoice.starred(inScope, favorites) else emptyList()
    // Which Claude account the slider shows, once the user taps one.
    var viewing by rememberSaveable { mutableStateOf<String?>(null) }
    Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
        if (inScope.isEmpty()) {
            Text(
                stringResource(if (scope == ModelScope.LOCAL) R.string.chats_scope_no_local else R.string.chats_scope_no_cloud),
                style = MaterialTheme.typography.bodyMedium,
                color = p.inkFaint,
                modifier = Modifier.padding(vertical = 8.dp).testTag("modelPicker.emptyScope"),
            )
        }
        if (starred.isNotEmpty()) {
            GroupTitle(stringResource(R.string.chats_starred))
            starred.forEach { (pr, m) ->
                val k = ModelPick(pr.id, m.id)
                ModelRow(m, detail = ProviderAccounts.shortName(pr), selected = k == selected) { onPick(k) }
            }
        }
        ModelSections.of(shown, viewing, selected, searching = query.isNotBlank()).forEach { section ->
            when (section) {
                is ModelSection.Provider -> {
                    ProviderGroupTitle(section.group.provider)
                    GroupModels(section.group, selected, onPick, onRetry)
                }
                is ModelSection.Accounts -> {
                    GroupTitle(stringResource(R.string.chats_account_family_claude))
                    AccountSlider(section, onTap = { g ->
                        viewing = g.provider.id
                        ModelSections.switchTo(section, g, selected)?.let(onPick)
                    })
                    GroupModels(section.shown, selected, onPick, onRetry)
                }
            }
        }
        if (shown.isEmpty() && inScope.isNotEmpty()) {
            Text(stringResource(R.string.chats_no_models_match, query.trim()), style = MaterialTheme.typography.bodyMedium, color = p.inkFaint)
        }
    }
}

/** One provider's models, or why there are none yet. */
@Composable
private fun GroupModels(g: ModelGroup, selected: ModelPick?, onPick: (ModelPick) -> Unit, onRetry: () -> Unit) {
    val p = Nekko.palette
    val list = g.models
    when {
        g.error != null -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.chats_list_models_failed, g.error.orEmpty()),
                style = MaterialTheme.typography.bodySmall,
                color = p.danger,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.chats_retry)) }
        }
        list == null -> Row(
            Modifier.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
            Text(stringResource(R.string.chats_asking), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        list.isEmpty() -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.chats_no_models),
                style = MaterialTheme.typography.bodySmall,
                color = p.inkFaint,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.chats_retry)) }
        }
        else -> list.forEach { m ->
            val k = ModelPick(g.provider.id, m.id)
            ModelRow(m, detail = null, selected = k == selected) { onPick(k) }
        }
    }
}

/**
 * The desktop's account slider: one tab per Claude login ("Personal · Max",
 * "Acme Inc · Team"), and under it the email and which account the one on
 * show is. Tapping a tab shows that account's models; when the pick is on
 * another of these accounts it also moves to the same model there.
 */
@Composable
private fun AccountSlider(section: ModelSection.Accounts, onTap: (ModelGroup) -> Unit) {
    val words = accountWords()
    val labels = ProviderAccounts.tabLabels(section.groups.map { it.provider }, words)
    val switcher = stringResource(R.string.chats_account_switcher)
    SingleChoiceSegmentedButtonRow(
        Modifier.fillMaxWidth().padding(top = 4.dp).semantics { contentDescription = switcher }.testTag("modelPicker.accounts"),
    ) {
        section.groups.forEachIndexed { i, g ->
            SegmentedButton(
                selected = g.provider.id == section.shown.provider.id,
                onClick = { onTap(g) },
                shape = SegmentedButtonDefaults.itemShape(i, section.groups.size),
                modifier = Modifier.testTag("modelPicker.accounts.${g.provider.id}"),
            ) {
                Text(labels.getValue(g.provider.id), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    ProviderAccounts.whoLine(section.shown.provider, words)?.let { who ->
        Text(
            who,
            style = MaterialTheme.typography.bodySmall,
            color = Nekko.palette.inkFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 8.dp, top = 4.dp, bottom = 2.dp).testTag("modelPicker.account.${section.shown.provider.id}"),
        )
    }
}

/**
 * All, Cloud and Local over the model list, after the desktop picker's Model source
 * group. Every tab stays on offer; an empty one says so in the list.
 */
@Composable
internal fun ModelScopeTabs(scope: ModelScope, onScope: (ModelScope) -> Unit) {
    val source = stringResource(R.string.chats_model_source)
    val tabs = ModelScope.entries
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().semantics { contentDescription = source }.testTag("modelPicker.scope")) {
        tabs.forEachIndexed { i, s ->
            SegmentedButton(
                selected = s == scope,
                onClick = { onScope(s) },
                shape = SegmentedButtonDefaults.itemShape(i, tabs.size),
                modifier = Modifier.testTag("modelPicker.scope.${s.name.lowercase()}"),
            ) {
                Text(
                    stringResource(
                        when (s) {
                            ModelScope.ALL -> R.string.chats_scope_all
                            ModelScope.CLOUD -> R.string.chats_scope_cloud
                            ModelScope.LOCAL -> R.string.chats_scope_local
                        },
                    ),
                    maxLines = 1,
                )
            }
        }
    }
}

/** The caption words for [ProviderAccounts], in the phone's language. */
@Composable
internal fun accountWords(): ProviderAccounts.Words = ProviderAccounts.Words(
    signedOut = stringResource(R.string.chats_account_signed_out),
    personalPlan = stringResource(R.string.chats_account_personal_plan),
    organization = stringResource(R.string.chats_account_organization),
)

/**
 * A provider's group in a model list: its title ("Personal · Max" for a Claude
 * plan login) and, for a Claude login, the email and which account it is under it.
 */
@Composable
internal fun ProviderGroupTitle(provider: PublicProvider) {
    val caption = ProviderAccounts.caption(provider, accountWords())
    GroupTitle(ProviderAccounts.title(provider))
    if (caption != null) {
        Text(
            caption,
            style = MaterialTheme.typography.bodySmall,
            color = Nekko.palette.inkFaint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 8.dp, bottom = 2.dp).testTag("modelPicker.account.${provider.id}"),
        )
    }
}

@Composable
private fun GroupTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = Nekko.palette.inkFaint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 10.dp, bottom = 2.dp, start = 8.dp),
    )
}

/** Keeps the pick across rotation and theme changes. */
private val ModelPickSaver = listSaver<ModelPick?, String>(
    save = { if (it == null) emptyList() else listOf(it.providerId, it.modelId) },
    restore = { if (it.size == 2) ModelPick(it[0], it[1]) else null },
)

@Composable
private fun ModelRow(m: ModelInfo, detail: String?, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) p.accentSoft else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(m.name, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (m.loaded) Pill(stringResource(R.string.chats_loaded), Tone.SUCCESS)
        if (selected) Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.chats_selected), tint = p.accent, modifier = Modifier.size(18.dp))
    }
}

/**
 * New chat while the computer is out of reach (offline mode): the first message,
 * the folder and the phone's default model for this computer go to the outbox,
 * and the chat is created there and the message sent when the computer is back
 * (*Start when online*). What is typed is kept as New chat's draft; a chat the
 * computer turned down comes back here with the reason.
 */
@Composable
private fun OfflineNewChat(
    repo: ComputersRepository,
    computer: String,
    phonePick: ModelPick?,
    workspaces: List<WorkspaceFolder>,
    shared: String?,
    onQueued: () -> Unit,
) {
    val p = Nekko.palette
    val saved = remember { repo.drafts.draft(DraftStore.NEW_CHAT) }
    var text by rememberSaveable { mutableStateOf(saved.text.ifEmpty { shared.orEmpty() }) }
    var workspaceId by rememberSaveable { mutableStateOf(saved.workspaceId) }
    // The model can't be listed offline: the one this chat came back with, else the phone's default for this computer.
    val pick = saved.providerId?.let { pid -> saved.modelId?.let { ModelPick(pid, it) } } ?: phonePick
    LaunchedEffect(text, workspaceId) {
        repo.drafts.set(DraftStore.NEW_CHAT, repo.drafts.draft(DraftStore.NEW_CHAT).copy(text = text, workspaceId = workspaceId))
    }
    NCard {
        // The iPhone's two lines (#2475): who is reconnecting, and that the draft will go when it does.
        com.nekko.android.ui.components.ReconnectingNotice(computer, Modifier.testTag("newChat.offlineNote"))
        saved.refusal?.let { Text(stringResource(R.string.chats_not_started, it), style = MaterialTheme.typography.bodySmall, color = p.danger) }
        if (pick == null) {
            Text(
                stringResource(R.string.chats_offline_no_model, computer),
                style = MaterialTheme.typography.bodySmall,
                color = p.warning,
            )
        } else {
            Label(Icons.Outlined.Memory, stringResource(R.string.chats_model_named, pick.modelId))
        }
        if (workspaces.isNotEmpty()) {
            Label(Icons.Outlined.Folder, stringResource(R.string.chats_folder))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(stringResource(R.string.chats_folder_none), workspaceId == null) { workspaceId = null }
                workspaces.forEach { w -> Chip(w.name, w.id == workspaceId) { workspaceId = w.id } }
            }
        }
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            label = { Text(stringResource(R.string.chats_first_message)) },
            minLines = 3,
            modifier = Modifier.fillMaxWidth().testTag("newChat.firstMessage"),
        )
        Button(
            onClick = {
                val chosen = pick ?: return@Button
                repo.outbox.add(null, text.trim(), newChat = NewChatSpec(chosen.providerId, chosen.modelId, workspaceId))
                repo.drafts.clear(DraftStore.NEW_CHAT)
                onQueued()
            },
            enabled = pick != null && text.isNotBlank(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("newChat.startWhenOnline"),
        ) { Text(stringResource(R.string.chats_start_when_online)) }
    }
}
