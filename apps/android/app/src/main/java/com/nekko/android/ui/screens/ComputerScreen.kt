package com.nekko.android.ui.screens

import androidx.annotation.StringRes
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.computer.MachineController
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.chat.RowChip
import com.nekko.android.ui.components.Dot
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.settings.routeLabel
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.ago
import com.nekko.android.util.localAgo
import com.nekko.protocol.AgentRows
import com.nekko.protocol.MachineSummary
import com.nekko.protocol.ModelInfo
import com.nekko.protocol.Pairing
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * One paired computer, opened (the iPhone's ComputerDetailView): what the phone
 * knows about it in one page. The round trip is measured here; the rest is the
 * computer's own `machine:summary`, its models, providers and usage. Connect,
 * rename, refresh and forget live in the ⋮ menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComputerScreen(repo: ComputersRepository, computerId: String, onBack: () -> Unit, onProviders: () -> Unit) {
    val s by repo.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val machine = remember(computerId) {
        MachineController(
            repo.caller, repo.appScope,
            reachable = { repo.state.value.activeId == computerId && repo.state.value.conn == RelayState.ONLINE },
            loadModels = { repo.loadAllModels() },
        )
    }
    val m by machine.state.collectAsStateWithLifecycle()
    DisposableEffect(machine) {
        machine.start()
        onDispose { machine.stop() }
    }
    // Back online, or this computer just became the one in use: read it again.
    LaunchedEffect(s.conn, s.activeId) { if (s.conn == RelayState.ONLINE && s.activeId == computerId) machine.refresh() }
    val c = s.computers.firstOrNull { it.id == computerId }
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var forgetting by remember { mutableStateOf(false) }
    val active = s.activeId == computerId

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_fact_computer)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back)) } },
                actions = {
                    if (c != null) Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.testTag("computer.edit")) {
                            Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.settings_edit_computer, c.name))
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            if (!active) DropdownMenuItem(
                                text = { Text(stringResource(R.string.settings_connect)) },
                                leadingIcon = { Icon(Icons.Filled.Bolt, contentDescription = null) },
                                onClick = { menu = false; scope.launch { repo.connect(c.id) } },
                            )
                            DropdownMenuItem(text = { Text(stringResource(R.string.settings_rename)) }, leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) }, onClick = { menu = false; renaming = true })
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.settings_refresh)) },
                                leadingIcon = { Icon(Icons.Filled.Refresh, contentDescription = null) },
                                onClick = { menu = false; scope.launch { machine.refresh() } },
                            )
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.settings_forget_ellipsis), color = p.danger) },
                                leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = p.danger) },
                                onClick = { menu = false; forgetting = true },
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (c == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.settings_computer_forgotten), style = MaterialTheme.typography.titleMedium, color = p.inkSoft)
            }
            return@Scaffold
        }
        val summary = m.summary
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            Hero(c, summary, active, s.conn)
            Tiles(c, m, active, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            if (!active) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Button(onClick = { scope.launch { repo.connect(c.id) } }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("computer.connect")) {
                        Text(stringResource(R.string.settings_connect_to, c.name))
                    }
                    Text(stringResource(R.string.settings_one_at_a_time), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                }
            } else if (m.summaryError != null && m.loadedOnce) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Info, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
                    Text(m.summaryError.orEmpty(), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                }
            }
            if (active) {
                val models = s.providers.filter { it.enabled }.flatMap { s.models[it.id].orEmpty() }
                if (models.isNotEmpty()) {
                    SectionHeader(stringResource(R.string.settings_models))
                    NCard(Modifier.padding(horizontal = 16.dp)) {
                        models.forEach { info -> ModelRow(info, info.loaded || info.id in m.loadedIds, s.providers.firstOrNull { it.id == info.providerId }?.label, s.defaults.defaultModelId == info.id) }
                    }
                }
                if (s.providers.isNotEmpty()) {
                    SectionHeader(stringResource(R.string.settings_providers))
                    NCard(Modifier.padding(horizontal = 16.dp)) {
                        s.providers.forEach { pr ->
                            Fact(pr.label, providerKind(pr.kind).let { if (pr.enabled) it else stringResource(R.string.settings_provider_off, it) })
                        }
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(onClick = onProviders).heightIn(min = 48.dp).testTag("computer.providers"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(stringResource(R.string.settings_add_switch_providers), style = MaterialTheme.typography.bodyMedium, color = p.accent, modifier = Modifier.weight(1f))
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
                        }
                    }
                }
            }
            if (summary != null) {
                SectionHeader(stringResource(R.string.settings_hardware))
                NCard(Modifier.padding(horizontal = 16.dp)) { Hardware(summary) }
            }
            SectionHeader(stringResource(R.string.settings_connection))
            NCard(Modifier.padding(horizontal = 16.dp)) {
                val route = if (active) s.route ?: c.relayUrl else c.relayUrl
                Fact(stringResource(R.string.settings_fact_route), "${routeLabel(RelayRoute.of(route))} · ${Pairing.relayHost(route)}")
                Fact(stringResource(R.string.settings_fact_status), stringResource(if (active) stateName(s.conn) else R.string.settings_state_idle))
                Fact(stringResource(R.string.settings_paired), ago(c.pairedAt).let { if (it == "now") stringResource(R.string.settings_just_now) else stringResource(R.string.settings_ago, localAgo(c.pairedAt)) })
                summary?.version?.let { v -> Fact("Nekko Agent", listOfNotNull(v, summary.edition).joinToString(" · ")) }
            }
            Spacer(Modifier.size(32.dp))
        }
    }

    if (renaming && c != null) {
        var name by remember(c.id) { mutableStateOf(c.name) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            title = { Text(stringResource(R.string.settings_rename_computer)) },
            text = { OutlinedTextField(value = name, onValueChange = { name = it.take(40) }, singleLine = true, label = { Text(stringResource(R.string.settings_name)) }) },
            confirmButton = {
                TextButton(onClick = { scope.launch { repo.rename(c.id, name) }; renaming = false }, enabled = name.isNotBlank()) { Text(stringResource(R.string.settings_save)) }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }
    if (forgetting && c != null) {
        AlertDialog(
            onDismissRequest = { forgetting = false },
            title = { Text(stringResource(R.string.settings_forget_title, c.name)) },
            text = { Text(stringResource(R.string.settings_forget_text)) },
            confirmButton = {
                TextButton(onClick = { forgetting = false; scope.launch { repo.forget(c.id); onBack() } }) { Text(stringResource(R.string.settings_forget), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { forgetting = false }) { Text(stringResource(R.string.settings_cancel)) } },
        )
    }
}

@Composable
private fun Hero(c: Computer, s: MachineSummary?, active: Boolean, conn: RelayState) {
    val p = Nekko.palette
    val stateText = stringResource(if (active) stateName(conn) else R.string.settings_state_idle)
    val parts = buildList {
        add(stateText)
        osName(s?.platform ?: c.platform)?.let { add(it) }
        s?.version?.let { add("Nekko Agent $it") }
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(14.dp)).background(p.accentSoft), contentAlignment = Alignment.Center) {
            Icon(Icons.Filled.Computer, contentDescription = null, tint = p.accent, modifier = Modifier.size(24.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(c.name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Dot(if (!active) Tone.FAINT else when (conn) {
                    RelayState.ONLINE -> Tone.SUCCESS
                    RelayState.CONNECTING, RelayState.OFFLINE -> Tone.WARNING
                    RelayState.DENIED -> Tone.DANGER
                    else -> Tone.FAINT
                })
                Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 2)
            }
        }
    }
}

/** Four stat tiles: the round trip with its last samples, the Model Server, uptime, and today's usage. */
@Composable
private fun Tiles(c: Computer, m: MachineController.State, active: Boolean, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val s = m.summary
    val big = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold)
    val small = MaterialTheme.typography.labelSmall
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile(stringResource(R.string.settings_round_trip), Modifier.weight(1f)) {
                val rt = m.latest
                if (rt != null) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${rt.ms}", style = big, color = p.ink)
                        Text("ms · ${routeLabel(RelayRoute.of(c.relayUrl))}", style = small, color = p.inkFaint, modifier = Modifier.padding(bottom = 3.dp))
                    }
                    Sparkline(m.samples.map { it.ms.toFloat() }, Modifier.fillMaxWidth().height(22.dp))
                } else {
                    Text(if (active) stringResource(R.string.settings_measuring) else "—", style = big, color = p.inkFaint)
                }
            }
            Tile(stringResource(R.string.settings_model_server), Modifier.weight(1f)) {
                if (s != null) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(if (s.serverRunning) stringResource(R.string.settings_loaded_count, s.resident.size) else stringResource(R.string.settings_off), style = big, color = p.ink)
                        if (s.loading > 0) Text(stringResource(R.string.settings_loading_count, s.loading), style = small, color = p.inkFaint, modifier = Modifier.padding(bottom = 3.dp))
                    }
                    val used = s.gpuUsedMB
                    val total = s.gpuTotalMB
                    if (used != null && total != null && total > 0) {
                        Bar((used / total).toFloat())
                        Text(stringResource(if (s.unified) R.string.settings_mem_of_unified else R.string.settings_mem_of, mb(used), mb(total)), style = small, color = p.inkFaint)
                    }
                } else {
                    Text("—", style = big, color = p.inkFaint)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Tile(stringResource(R.string.settings_up), Modifier.weight(1f)) {
                Text(s?.let { AgentRows.span(it.uptimeMs.toDouble()) } ?: "—", style = big, color = if (s == null) p.inkFaint else p.ink)
                Text(ago(c.pairedAt).let { if (it == "now") stringResource(R.string.settings_paired_just_now) else stringResource(R.string.settings_paired_ago, localAgo(c.pairedAt)) }, style = small, color = p.inkFaint)
            }
            Tile(stringResource(R.string.settings_today), Modifier.weight(1f)) {
                val d = m.today(System.currentTimeMillis())
                Text(String.format(Locale.US, "$%.2f", d?.cost ?: 0.0), style = big, color = p.ink)
                Text(if (d == null) stringResource(R.string.settings_no_usage) else stringResource(R.string.settings_tokens_count, compact(d.tokens)), style = small, color = p.inkFaint)
            }
        }
    }
}

/** A stat tile: a small uppercase title, then whatever the stat needs. */
@Composable
private fun Tile(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val p = Nekko.palette
    Column(
        modifier.clip(RoundedCornerShape(12.dp)).background(p.surface).padding(12.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, letterSpacing = 0.5.sp, color = p.inkFaint)
        content()
    }
}

@Composable
private fun Bar(fraction: Float) {
    val p = Nekko.palette
    Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(p.surface2).clearAndSetSemantics {}) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).height(6.dp).clip(CircleShape).background(p.accent))
    }
}

/** The last round trips as a line with a faint fill, drawn to its own scale. */
@Composable
private fun Sparkline(values: List<Float>, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val description = stringResource(R.string.settings_round_trip_samples, values.size)
    Canvas(modifier.semantics { contentDescription = description }) {
        if (values.isEmpty()) return@Canvas
        val lo = values.min()
        val hi = maxOf(values.max(), lo + 1f)
        val pts = values.mapIndexed { i, v ->
            Offset(if (values.size > 1) i / (values.size - 1f) * size.width else size.width, size.height - (v - lo) / (hi - lo) * (size.height - 4f) - 2f)
        }
        val fill = Path().apply {
            moveTo(pts.first().x, size.height)
            pts.forEach { lineTo(it.x, it.y) }
            lineTo(pts.last().x, size.height)
            close()
        }
        drawPath(fill, p.accent.copy(alpha = 0.12f))
        val line = Path().apply {
            moveTo(pts.first().x, pts.first().y)
            pts.drop(1).forEach { lineTo(it.x, it.y) }
        }
        drawPath(line, p.accent, style = Stroke(width = 1.5.dp.toPx()))
        drawCircle(p.accent, radius = 2.dp.toPx(), center = pts.last())
    }
}

@Composable
private fun ModelRow(info: ModelInfo, loaded: Boolean, provider: String?, default: Boolean) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(if (loaded) Icons.Filled.Circle else Icons.Outlined.Circle, contentDescription = null, tint = if (loaded) p.success else p.inkFaint, modifier = Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(info.name, style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(provider, if (loaded) stringResource(R.string.settings_loaded) else null).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        if (default) RowChip(stringResource(R.string.settings_default), tone = AgentRows.Tone.QUIET)
    }
}

@Composable
private fun Hardware(s: MachineSummary) {
    s.cpuModel?.let { cpu -> Fact(stringResource(R.string.settings_chip), s.cpuCores?.let { stringResource(R.string.settings_chip_cores, cpu, it) } ?: cpu) }
    s.ramBytes?.let { ram ->
        val total = s.memTotalMB
        val used = s.memUsedMB
        Fact(stringResource(R.string.settings_memory), if (total != null && used != null) stringResource(if (s.unified) R.string.settings_memory_free_unified else R.string.settings_memory_free, bytes(ram), mb(total - used)) else bytes(ram))
    }
    s.gpus.forEach { g ->
        Fact("GPU", listOfNotNull(g.name, g.cores?.let { stringResource(R.string.settings_n_cores, it) }, s.gpuC?.let { "${Math.round(it)} °C" }).joinToString(" · "))
    }
    s.cpuPct?.let { pct -> Fact(stringResource(R.string.settings_cpu_now), "${Math.round(pct)}%" + (s.cpuC?.let { " · ${Math.round(it)} °C" } ?: "")) }
    if (s.backends.isNotEmpty()) Fact(stringResource(R.string.settings_backends), s.backends.joinToString(", "))
    s.diskFreeBytes?.let { Fact(stringResource(R.string.settings_free_for_models), bytes(it)) }
}

@Composable
private fun Fact(label: String, value: String) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
    }
}

@StringRes
private fun stateName(s: RelayState) = when (s) {
    RelayState.ONLINE -> R.string.settings_state_online
    RelayState.CONNECTING -> R.string.settings_state_connecting_dots
    RelayState.OFFLINE -> R.string.settings_state_offline_short
    RelayState.DENIED -> R.string.settings_state_not_paired
    else -> R.string.settings_state_idle
}

private fun osName(platform: String?) = when (platform) {
    null -> null
    "darwin" -> "macOS"
    "win32" -> "Windows"
    "linux" -> "Linux"
    else -> platform
}

@Composable
private fun providerKind(kind: String) = when (kind) {
    "anthropic" -> stringResource(R.string.settings_kind_api_key, "Anthropic")
    "openai" -> stringResource(R.string.settings_kind_api_key, "OpenAI")
    "openrouter" -> stringResource(R.string.settings_kind_api_key, "OpenRouter")
    "chatgpt" -> stringResource(R.string.settings_kind_subscription, "ChatGPT")
    "llamacpp" -> stringResource(R.string.settings_kind_model_server)
    "ollama" -> stringResource(R.string.settings_kind_local, "Ollama")
    "lmstudio" -> stringResource(R.string.settings_kind_local, "LM Studio")
    "vllm" -> stringResource(R.string.settings_kind_local, "vLLM")
    "openai-compat" -> stringResource(R.string.settings_kind_openai_compat)
    "bedrock" -> "Amazon Bedrock"
    "vertex" -> "Google Vertex"
    "foundry" -> "Azure AI Foundry"
    else -> kind
}

/** Binary units, as the iPhone's memory formatter: "128 GB". */
internal fun bytes(b: Double): String {
    val units = listOf("bytes", "KB", "MB", "GB", "TB")
    var v = b
    var i = 0
    while (v >= 1024 && i < units.lastIndex) { v /= 1024; i++ }
    return if (i == 0 || v >= 100 || v % 1.0 == 0.0) "${Math.round(v)} ${units[i]}" else String.format(Locale.US, "%.1f %s", v, units[i])
}

private fun mb(v: Double) = bytes(v * 1_048_576)

private fun compact(n: Long): String = when {
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format(Locale.US, "%.1fK", n / 1_000.0)
    else -> "$n"
}
