package com.nekko.android.ui.screens

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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.Notes
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.ModelChoice
import com.nekko.android.data.ModelGroup
import com.nekko.android.data.ModelPick
import com.nekko.android.data.modelGroups
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Channels
import com.nekko.protocol.Effort
import com.nekko.protocol.LocalProviders
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.RelayState
import com.nekko.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
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
    shared: String? = null,
    onEditShared: (String) -> Unit = {},
    onPair: () -> Unit,
    onCreated: (String) -> Unit,
) {
    val c by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val active = c.active
    val online = c.conn == RelayState.ONLINE
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

    // The models are the computer's: ask every enabled provider there, in parallel.
    LaunchedEffect(online, c.providers) {
        if (online && c.providers.isNotEmpty()) {
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
    LaunchedEffect(groups, c.defaults, c.summaries, phonePick) {
        // Until the user picks, keep following the best candidate: the lists arrive one provider
        // at a time, so the phone's model may show up after the computer's default was chosen.
        if (!touched) pick = ModelChoice.initial(c.defaults, c.summaries, groups, phonePick) ?: pick
    }
    val phonePickMissing = ModelChoice.phonePickMissing(phonePick, groups)
    // A level the chosen model doesn't take is cleared.
    LaunchedEffect(pick) {
        if (effort != null && Effort.levels(pick?.modelId).none { it.wire == effort }) effort = null
    }
    val pickedKind = c.providers.firstOrNull { it.id == pick?.providerId }?.kind
    // A local model runs on its computer's hardware: offer the other paired computers.
    val showRunOn = c.computers.size > 1 && (switched || LocalProviders.isLocal(pickedKind))
    val runOn: (String) -> Unit = { id ->
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
                    error = e.message ?: "Couldn’t connect to that computer."
                }
            }
        }
    }

    val start: () -> Unit = start@{
        val chosen = pick
        if (chosen == null) {
            error = "Pick a model for this chat."
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
                val session = Session.from(created) ?: throw IllegalStateException("Your computer didn’t create the chat.")
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
                error = e.message ?: "Couldn’t start the chat."
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
                title = { Text("New chat") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            if (shared != null) SharedTextCard(shared, onEditShared)
            SectionHeader(if (active != null) "On ${active.name}" else "On your computer")
            Column(Modifier.padding(horizontal = 16.dp)) {
                when {
                    active == null -> NCard {
                        Text(
                            "Pair your computer to run chats there, with its models, files and tools.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.inkSoft,
                        )
                        OutlinedButton(onClick = onPair, modifier = Modifier.heightIn(min = 48.dp)) {
                            Icon(Icons.Filled.QrCode2, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Pair a computer")
                        }
                    }
                    !online -> NCard {
                        Text(
                            "${active.name} is ${if (c.conn == RelayState.CONNECTING) "connecting…" else "offline"}. Open Nekko Agent on your computer and try again.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = p.inkSoft,
                        )
                    }
                    else -> NCard {
                        Label(Icons.Filled.Memory, "Model · from ${active.name}")
                        if (phonePickMissing && !touched) {
                            Text(
                                "Your default model for ${active.name} (${phonePick?.modelId}) isn’t available any more, so this uses the computer’s default. Change it in Settings → New chats.",
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
                                error = null
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
                        if (chosen != null) {
                            Label(Icons.Filled.Speed, "Effort")
                            Row(Modifier.horizontalScroll(rememberScrollState()).testTag("newChat.effort"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Chip("Computer default", effort == null) { effort = null }
                                Effort.levels(chosen.modelId).forEach { e -> Chip(e.label, effort == e.wire) { effort = e.wire } }
                            }
                        }
                        if (c.workspaces.isNotEmpty()) {
                            Label(Icons.Filled.Folder, "Folder")
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Chip("None", workspaceId == null) { workspaceId = null }
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
                                Icon(Icons.Filled.Computer, contentDescription = null, modifier = Modifier.size(18.dp))
                            }
                            Spacer(Modifier.size(8.dp))
                            Text("Start on ${active.name}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                if (showRunOn) {
                    Spacer(Modifier.size(12.dp))
                    NCard {
                        Label(Icons.Filled.Computer, "Run on")
                        Row(Modifier.horizontalScroll(rememberScrollState()).testTag("newChat.runOn"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            c.computers.forEach { pc -> Chip(pc.name, pc.id == c.activeId) { runOn(pc.id) } }
                        }
                        Text(
                            "A local model runs on the computer’s own hardware. Choosing another computer shows its models and folders.",
                            style = MaterialTheme.typography.bodySmall,
                            color = p.inkSoft,
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
    SectionHeader("Shared with Nekko")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f)) { Label(Icons.AutoMirrored.Filled.Notes, "Goes into the chat’s message box. You send it.") }
                IconButton(onClick = { onEdit("") }) {
                    Icon(Icons.Filled.Close, contentDescription = "Remove shared text", tint = p.inkFaint)
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
        Icon(icon, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = p.accent, selectedLabelColor = p.accentInk),
        modifier = Modifier.heightIn(min = 48.dp),
    )
}

/**
 * Every enabled provider's models on the computer in one list, grouped by
 * provider like the desktop picker, the computer's starred models first.
 */
@Composable
private fun ModelList(
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
            "No model providers are switched on in Nekko Agent on your computer. Add or enable one in its Models settings.",
            style = MaterialTheme.typography.bodyMedium,
            color = p.inkFaint,
        )
        return
    }
    val total = groups.sumOf { it.models?.size ?: 0 }
    if (total > 8 || query.isNotEmpty()) {
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            singleLine = true,
            placeholder = { Text("Search models") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            modifier = Modifier.fillMaxWidth(),
        )
    }
    val shown = ModelChoice.filter(groups, query)
    val starred = if (query.isBlank()) ModelChoice.starred(groups, favorites) else emptyList()
    Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
        if (starred.isNotEmpty()) {
            GroupTitle("Starred")
            starred.forEach { (pr, m) ->
                val k = ModelPick(pr.id, m.id)
                ModelRow(m, detail = pr.label, selected = k == selected) { onPick(k) }
            }
        }
        shown.forEach { g ->
            GroupTitle(g.provider.label)
            val list = g.models
            when {
                g.error != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Couldn’t list its models. ${g.error}",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.danger,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onRetry) { Text("Retry") }
                }
                list == null -> Row(
                    Modifier.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                    Text("Asking your computer…", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                }
                list.isEmpty() -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "No models available. Is its server running?",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onRetry) { Text("Retry") }
                }
                else -> list.forEach { m ->
                    val k = ModelPick(g.provider.id, m.id)
                    ModelRow(m, detail = null, selected = k == selected) { onPick(k) }
                }
            }
        }
        if (shown.isEmpty()) {
            Text("No models match “${query.trim()}”.", style = MaterialTheme.typography.bodyMedium, color = p.inkFaint)
        }
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
        if (m.loaded) Pill("loaded", Tone.SUCCESS)
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = p.accent, modifier = Modifier.size(18.dp))
    }
}
