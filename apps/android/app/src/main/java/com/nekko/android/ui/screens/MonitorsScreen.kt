package com.nekko.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.nekko.android.data.ComputersRepository
import com.nekko.android.monitors.MonitorsViewModel
import com.nekko.android.ui.chat.QuestionCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.RowDivider
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.components.toneColor
import com.nekko.android.ui.panes.PaneSlot
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.util.plainText
import com.nekko.protocol.AskRequest
import com.nekko.protocol.MonitorSummary
import com.nekko.protocol.RelayState
import com.nekko.protocol.Severity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * The phone edition of the desktop's Agent Monitor dock, read only but for what
 * needs the owner: the computer's **Hardware** (load and temperatures), **Running**
 * chats (tap to open), **Needs you** (Allow / Deny / answer inline) and the next
 * **Automations**. A pane on an open folding phone ([pane] set) and a screen from
 * the chat list on any phone. It reads `monitor:summary` every 10 s only while it
 * is on screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MonitorsScreen(
    vm: MonitorsViewModel,
    repo: ComputersRepository,
    onOpenChat: (String) -> Unit,
    /** Back on the closed phone; null in a pane. */
    onBack: (() -> Unit)? = null,
    pane: PaneSlot? = null,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val computers by repo.state.collectAsStateWithLifecycle()
    val computer = computers.active?.name ?: "your computer"
    val p = Nekko.palette
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Polls only while visible: STARTED and on screen; stops in the background.
    LaunchedEffect(vm, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { vm.whileVisible() } }
    // Running times count on between reads.
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(1_000)
            value = System.currentTimeMillis()
        }
    }
    val summary = state.summary

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Monitors", style = MaterialTheme.typography.titleMedium) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                    }
                },
                actions = { pane?.actions?.invoke(this) },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()).navigationBarsPadding(),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            val notice = when {
                state.readOff -> "Read is off for this phone. Turn it on on $computer in Remote access → What phones can do."
                computers.conn != RelayState.ONLINE -> "$computer is ${if (computers.conn == RelayState.OFFLINE) "offline" else "reconnecting"}. Monitors update once it answers."
                else -> state.error
            }
            notice?.let { msg ->
                item(key = "notice") {
                    Notice(msg, if (state.readOff) Tone.WARNING else Tone.DANGER, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                }
            }
            if (state.readOff) return@LazyColumn
            if (summary == null) {
                if (state.loading && computers.conn == RelayState.ONLINE) {
                    item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = p.accent)
                        }
                    }
                }
                return@LazyColumn
            }

            val needs = state.needsYou
            val sections = monitorSections(summary.running.size, needs.size)
            item(key = "hardware") { SectionHeader("Hardware · $computer", accent = true) }
            item(key = "hw-rows") { HardwareRows(summary.hardware) }

            // Running and Needs you show only while they hold something.
            if (MonitorSection.RUNNING in sections) {
                item(key = "running") { SectionHeader("Running", accent = true) }
                itemsIndexed(summary.running, key = { _, r -> "run:${r.id}" }) { i, r ->
                    if (i > 0) RowDivider(40.dp)
                    val elapsed = r.elapsedMs?.let { it + (now - (state.readAt ?: now)).coerceAtLeast(0) }
                    RunningRow(r, elapsed) { onOpenChat(r.id) }
                }
            }

            if (MonitorSection.NEEDS_YOU in sections) item(key = "needs") { SectionHeader("Needs you", accent = true) }
            itemsIndexed(needs, key = { _, n -> "need:${n.key}" }) { i, row ->
                if (i > 0) RowDivider()
                NeedsYouRow(
                    row = row,
                    onOpen = { onOpenChat(row.sessionId) },
                    decide = { ok -> vm.decide(row, ok) },
                    loadQuestion = { vm.question(row) },
                    answer = { answers -> vm.answer(row, answers) },
                )
            }

            item(key = "automations") { SectionHeader("Automations", accent = true) }
            if (summary.automations.isEmpty()) item(key = "auto-none") { Empty("No scheduled runs.") }
            itemsIndexed(summary.automations, key = { _, a -> "auto:${a.kind}:${a.id}" }) { i, a ->
                if (i > 0) RowDivider(40.dp)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(16.dp))
                    Text(plainText(a.name).ifEmpty { "Automation" }, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(MonitorSummary.nextRun(a.nextRunAt, now), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                }
            }
        }
    }
}

/** The Monitors screen's groups, in order. */
internal enum class MonitorSection { HARDWARE, RUNNING, NEEDS_YOU, AUTOMATIONS }

/** Which groups show: Running and Needs you only while they hold at least one chat. */
internal fun monitorSections(running: Int, needsYou: Int): List<MonitorSection> = buildList {
    add(MonitorSection.HARDWARE)
    if (running > 0) add(MonitorSection.RUNNING)
    if (needsYou > 0) add(MonitorSection.NEEDS_YOU)
    add(MonitorSection.AUTOMATIONS)
}

@Composable
private fun Empty(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
}

/** CPU, GPU and memory: load as a bar, the temperature beside it when there is a sensor. */
@Composable
private fun HardwareRows(hw: MonitorSummary.Hardware) {
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LoadBar("CPU", hw.cpu.loadPct, hw.cpu.tempC, if (hw.cpu.cores > 0) "${hw.cpu.cores} cores" else null)
        hw.gpu?.let { g ->
            val mem = if (!g.unified && g.memoryTotalMB != null && g.memoryTotalMB!! > 0) gb(g.memoryUsedMB ?: 0.0, g.memoryTotalMB!!) else null
            LoadBar("GPU", g.loadPct, g.tempC, mem ?: if (g.unified) "shared memory" else null)
        }
        LoadBar("Memory", hw.memory.usedPct, hw.memory.tempC, if (hw.memory.totalMB > 0) gb(hw.memory.usedMB, hw.memory.totalMB) else null)
    }
}

private fun gb(usedMB: Double, totalMB: Double) = String.format(Locale.US, "%.1f / %.0f GB", usedMB / 1024, totalMB / 1024)

@Composable
private fun LoadBar(label: String, pct: Double?, tempC: Double?, detail: String?) {
    val p = Nekko.palette
    val load = (pct ?: 0.0).coerceIn(0.0, 100.0)
    val tone = when {
        load >= 90 || (tempC ?: 0.0) >= 90 -> Tone.DANGER
        load >= 70 || (tempC ?: 0.0) >= 80 -> Tone.WARNING
        else -> Tone.ACCENT
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.width(64.dp))
            Box(Modifier.weight(1f).height(6.dp).clip(RoundedCornerShape(3.dp)).background(p.surface2)) {
                if (pct != null) {
                    Box(Modifier.fillMaxWidth((load / 100).toFloat()).height(6.dp).clip(RoundedCornerShape(3.dp)).background(toneColor(tone)))
                }
            }
            Text(
                if (pct == null) "—" else "${load.toInt()}%",
                style = MaterialTheme.typography.bodySmall,
                color = p.inkSoft,
                modifier = Modifier.width(40.dp),
            )
            Text(tempC?.let { "${it.toInt()}°" } ?: "", style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.width(36.dp))
        }
        detail?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = p.inkFaint, modifier = Modifier.padding(start = 72.dp)) }
    }
}

@Composable
private fun RunningRow(r: MonitorSummary.Running, elapsedMs: Long?, onOpen: () -> Unit) {
    val p = Nekko.palette
    val (step, tone) = when (r.step) {
        MonitorSummary.Step.APPROVAL -> "needs your approval" to Tone.WARNING
        MonitorSummary.Step.QUESTION -> "has a question" to Tone.WARNING
        MonitorSummary.Step.WORKING -> "working" to Tone.ACCENT
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = "Open chat", onClick = onOpen)
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (tone == Tone.WARNING) Icons.Filled.Warning else Icons.Filled.Bolt, contentDescription = null, tint = toneColor(tone), modifier = Modifier.size(16.dp))
        Column(Modifier.weight(1f)) {
            Text(plainText(r.title).ifEmpty { "Chat" }, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(step, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        elapsedMs?.let { Text(MonitorSummary.elapsed(it), style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
    }
}

/**
 * An approval (Allow / Deny, the same `tool:approve` as the chat's card) or a question
 * (Answer opens the chat's own question card here, read from `chat:pending`). Tap the
 * title to open the chat for the full command or question.
 */
@Composable
private fun NeedsYouRow(
    row: MonitorSummary.NeedsYou,
    onOpen: () -> Unit,
    decide: suspend (Boolean) -> Unit,
    loadQuestion: suspend () -> AskRequest?,
    answer: suspend (List<com.nekko.protocol.AskAnswer>) -> Unit,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var busy by remember(row.key) { mutableStateOf<Boolean?>(null) }
    var error by remember(row.key) { mutableStateOf<String?>(null) }
    var question by remember(row.key) { mutableStateOf<AskRequest?>(null) }
    var loading by remember(row.key) { mutableStateOf(false) }
    val approval = row.kind == MonitorSummary.Kind.APPROVAL
    val tone = when (row.risk) {
        Severity.HIGH -> Tone.DANGER
        Severity.MEDIUM -> Tone.WARNING
        Severity.LOW -> Tone.ACCENT
        null -> Tone.WARNING
    }
    fun run(block: suspend () -> Unit) {
        error = null
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn’t reach your computer."
            } finally {
                busy = null
                loading = false
            }
        }
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Open chat", onClick = onOpen).heightIn(min = 40.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(plainText(row.title).ifEmpty { "Chat" }, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val more = if (!approval && row.count > 1) " (and ${row.count - 1} more)" else ""
                Text(
                    (if (approval) "Wants to run ${row.label}" else row.label) + more,
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkSoft,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (approval) Pill("${row.risk?.name?.lowercase() ?: "medium"} risk", tone)
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
        val q = question
        when {
            approval -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { busy = false; run { decide(false) } },
                    enabled = busy == null,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                ) { Text(if (busy == false) "Denying…" else "Deny") }
                Button(
                    onClick = { busy = true; run { decide(true) } },
                    enabled = busy == null,
                    colors = ButtonDefaults.buttonColors(containerColor = toneColor(tone), contentColor = p.accentInk),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                ) { Text(if (busy == true) "Allowing…" else "Allow") }
            }
            q != null -> QuestionCard(q, onAnswer = answer)
            else -> OutlinedButton(
                onClick = {
                    loading = true
                    run {
                        val found = loadQuestion()
                        if (found == null) error = "Already answered." else question = found
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(if (loading) "Opening…" else "Answer") }
        }
    }
}
