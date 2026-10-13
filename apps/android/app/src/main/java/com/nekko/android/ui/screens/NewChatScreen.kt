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
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.AUTO_MODEL_ID
import com.nekko.protocol.Channels
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.RelayState
import com.nekko.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Start a chat on the active computer: pick a model (and optionally a folder). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(
    repo: ComputersRepository,
    onBack: () -> Unit,
    onPair: () -> Unit,
    onCreated: (String) -> Unit,
) {
    val c by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val active = c.active
    val online = c.conn == RelayState.ONLINE
    val providers = c.providers.filter { it.enabled }

    var providerId by rememberSaveable { mutableStateOf(c.defaults.defaultProviderId) }
    var modelId by rememberSaveable { mutableStateOf(c.defaults.defaultModelId?.takeIf { it != AUTO_MODEL_ID }) }
    var workspaceId by rememberSaveable { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf<List<ModelInfo>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Defaults may arrive after the screen opens (first refresh still running).
    LaunchedEffect(c.defaults) {
        if (providerId == null) providerId = c.defaults.defaultProviderId
        if (modelId == null) modelId = c.defaults.defaultModelId?.takeIf { it != AUTO_MODEL_ID }
    }
    LaunchedEffect(online, providerId) {
        val pid = providerId
        if (!online || pid == null) return@LaunchedEffect
        models = null
        models = try {
            repo.loadModels(pid)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }

    val start: () -> Unit = start@{
        val pid = providerId
        val mid = modelId
        if (pid == null || mid == null || mid == AUTO_MODEL_ID) {
            error = "Pick a model for this chat."
            return@start
        }
        busy = true
        error = null
        scope.launch {
            try {
                val r = repo.remote()
                val created = r.call(Channels.SESSION_CREATE, *listOfNotNull(workspaceId?.let { JsonPrimitive(it) }).toTypedArray())
                val session = Session.from(created) ?: throw IllegalStateException("Your computer didn’t create the chat.")
                r.call(Channels.SESSION_SET_OPTIONS, JsonPrimitive(session.id), buildJsonObject {
                    put("providerId", pid)
                    put("modelId", mid)
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
                        Label(Icons.Filled.Memory, "Model")
                        if (providers.isEmpty()) {
                            Text("No providers are enabled on your computer.", style = MaterialTheme.typography.bodyMedium, color = p.inkFaint)
                        }
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            providers.forEach { pr ->
                                Chip(pr.label, pr.id == providerId) {
                                    if (providerId != pr.id) {
                                        providerId = pr.id
                                        modelId = null
                                    }
                                }
                            }
                        }
                        val list = models
                        when {
                            providerId == null -> Unit
                            list == null -> CircularProgressIndicator(color = p.accent, modifier = Modifier.size(24.dp))
                            list.isEmpty() -> Text(
                                "No models found for this provider on your computer.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = p.inkFaint,
                            )
                            else -> Column(
                                Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
                            ) {
                                list.forEach { m ->
                                    ModelRow(m, selected = m.id == modelId) {
                                        modelId = m.id
                                        error = null
                                    }
                                }
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
            }
            Spacer(Modifier.size(32.dp))
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

@Composable
private fun ModelRow(m: ModelInfo, selected: Boolean, onClick: () -> Unit) {
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
        Text(m.name, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (m.loaded) Pill("loaded", Tone.SUCCESS)
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", tint = p.accent, modifier = Modifier.size(18.dp))
    }
}
