package com.nekko.android.ui.screens

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.beyond.AutomationsController
import com.nekko.android.beyond.UsageController
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.AutomationTask
import com.nekko.protocol.AutomationWorkflow
import com.nekko.protocol.ProviderLimits
import com.nekko.protocol.RelayState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Page(title: String, onBack: () -> Unit, onRefresh: () -> Unit, content: @Composable (PaddingValues) -> Unit) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                title = { Text(title, modifier = Modifier.semantics { heading() }) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
                actions = { IconButton(onClick = onRefresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") } },
            )
        },
    ) { padding ->
        // On an open folding phone, keep the list a readable width.
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) { content(PaddingValues(16.dp)) }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp).semantics { heading() })
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

private fun ago(ms: Long): String {
    val now = System.currentTimeMillis()
    if (now - ms in 0 until DateUtils.MINUTE_IN_MILLIS) return "just now"
    return DateUtils.getRelativeTimeSpanString(ms, now, DateUtils.MINUTE_IN_MILLIS).toString()
}

/**
 * The computer's automations (AN-29, the iPhone's `AutomationsView`): its
 * tasks and workflows, how each last went, and **Run now**. Setting them up
 * and changing them happens on the computer.
 */
@Composable
fun AutomationsScreen(repo: ComputersRepository, onBack: () -> Unit) {
    val p = Nekko.palette
    val c by repo.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val a = remember { AutomationsController(repo.caller, { repo.state.value.conn == RelayState.ONLINE }, scope) }
    val s by a.state.collectAsStateWithLifecycle()
    var running by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    val computer = c.active?.name ?: "your computer"
    LaunchedEffect(a) { a.load() }
    fun run(id: String, call: suspend () -> Unit) {
        running = id
        scope.launch {
            try {
                call()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = e.message ?: "Couldn’t run it."
            } finally {
                running = null
            }
        }
    }
    Page("Automations", onBack, onRefresh = { scope.launch { a.load() } }) { pad ->
        LazyColumn(Modifier.fillMaxSize().testTag("automations.list"), contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (c.pcSettings.automationsPaused) item { Notice("Automations are paused on $computer. Run now still works.", Tone.WARNING) }
            s.error?.let { item { Notice(it, Tone.DANGER) } }
            if (s.loaded && s.error == null && s.isEmpty) {
                item { Text("No automations yet. Set them up on $computer, and run them from here.", color = p.inkSoft) }
            }
            if (s.tasks.isNotEmpty()) {
                item { Label("Tasks") }
                items(s.tasks, key = { "t:${it.id}" }) { t ->
                    AutomationRow(
                        t.title, t.cadence { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(it)) },
                        taskStatus(t), t.lastResult, t.lastRunAt, started = t.id in s.started, busy = running == t.id,
                    ) { run(t.id) { a.runTask(t.id) } }
                }
            }
            if (s.workflows.isNotEmpty()) {
                item { Label("Workflows") }
                items(s.workflows, key = { "w:${it.id}" }) { w ->
                    AutomationRow(w.name, w.detail, workflowStatus(w), w.description, w.lastRunAt, started = w.id in s.started, busy = running == w.id) {
                        run(w.id) { a.runWorkflow(w.id) }
                    }
                }
            }
            if (!s.loaded) item { CircularProgressIndicator(color = p.accent) }
        }
    }
    failed?.let { m ->
        AlertDialog(
            onDismissRequest = { failed = null },
            title = { Text("Couldn’t run it") },
            text = { Text(m) },
            confirmButton = { TextButton(onClick = { failed = null }) { Text("OK") } },
        )
    }
}

@Composable
private fun taskStatus(t: AutomationTask): Pair<String, Color>? {
    val p = Nekko.palette
    return when {
        t.failed -> "Last run failed" to p.danger
        t.paused -> "Paused" to p.inkSoft
        t.status == "done" -> "Done" to p.success
        else -> null
    }
}

@Composable
private fun workflowStatus(w: AutomationWorkflow): Pair<String, Color>? {
    val p = Nekko.palette
    return when (w.lastStatus) {
        "success" -> "Last run passed" to p.success
        "failure" -> "Last run failed" to p.danger
        "running", "queued" -> "Running" to p.running
        "cancelled" -> "Last run cancelled" to p.inkSoft
        else -> null
    }
}

@Composable
private fun AutomationRow(
    title: String,
    detail: String,
    status: Pair<String, Color>?,
    result: String?,
    lastRun: Long?,
    started: Boolean,
    busy: Boolean,
    onRun: () -> Unit,
) {
    val p = Nekko.palette
    Card {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = p.ink)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            }
            Box(Modifier.heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                if (busy) {
                    CircularProgressIndicator(color = p.accent, modifier = Modifier.size(20.dp))
                } else {
                    TextButton(
                        onClick = onRun,
                        modifier = Modifier.testTag("automations.run").semantics { contentDescription = if (started) "$title started" else "Run $title now" },
                    ) { Text(if (started) "Started" else "Run now", color = if (started) p.inkSoft else p.accent, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
        status?.let { (text, color) -> Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = color) }
        lastRun?.let { Text("Last run ${ago(it)}", style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
        result?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 4) }
    }
}

/** What the computer's providers have used, and each plan's limits (AN-29, the iPhone's `UsageView`). Read only. */
@Composable
fun UsageScreen(repo: ComputersRepository, onBack: () -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val u = remember { UsageController(repo.caller) { repo.state.value.providers } }
    val s by u.state.collectAsStateWithLifecycle()
    LaunchedEffect(u) { u.load() }
    val money = remember { NumberFormat.getCurrencyInstance(Locale.US).apply { currency = Currency.getInstance("USD") } }
    val compact = { n: Long -> compactNumber(n) }
    Page("Usage and limits", onBack, onRefresh = { scope.launch { u.load() } }) { pad ->
        LazyColumn(Modifier.fillMaxSize().testTag("usage.view"), contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            s.error?.let { item { Notice(it, Tone.DANGER) } }
            items(s.limited, key = { "l:${it.first.id}" }) { (provider, limits) ->
                Label(listOfNotNull(provider.label, limits.planType?.replaceFirstChar { it.uppercase() }).joinToString(" · "))
                Card {
                    if (limits.windows.isEmpty()) Text("No limits reported.", style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                    limits.windows.forEach { LimitBar(it) }
                }
            }
            val sum = s.summary
            if (sum != null) {
                item {
                    Label("All time")
                    Card {
                        Line("Tokens", compact(sum.totalTokens))
                        Line("Estimated spend", money.format(sum.totalCost))
                    }
                }
                if (sum.days.isNotEmpty()) item {
                    Label("Recent days")
                    Card { sum.days.reversed().forEach { d -> Line(d.date, "${compact(d.tokens)} · ${money.format(d.cost)}") } }
                }
                if (sum.models.isNotEmpty()) item {
                    Label("By model")
                    Card {
                        sum.models.forEach { m -> Line(m.model, if (m.subscription) "${compact(m.tokens)} · plan" else "${compact(m.tokens)} · ${money.format(m.cost)}") }
                    }
                }
            } else if (s.loaded && s.error == null) {
                item { Text("No usage recorded yet.", color = p.inkSoft) }
            }
            if (!s.loaded) item { CircularProgressIndicator(color = p.accent) }
        }
    }
}

@Composable
private fun Line(label: String, value: String) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
    }
}

@Composable
private fun LimitBar(w: ProviderLimits.Window) {
    val p = Nekko.palette
    val color = when {
        w.limited -> p.danger
        w.status == "warning" || w.usedPercent >= 80 -> p.warning
        else -> p.success
    }
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            Text(w.label, style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.weight(1f))
            Text("${Math.round(w.usedPercent)}% used", style = MaterialTheme.typography.bodyMedium, color = color)
        }
        LinearProgressIndicator(progress = { (w.usedPercent / 100).toFloat() }, color = color, trackColor = p.line, modifier = Modifier.fillMaxWidth())
        w.resetAt?.takeIf { it > 0 }?.let { Text("Resets ${ago(it)}", style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
    }
}

/** 1,234 → 1.2K, 3,400,000 → 3.4M. */
internal fun compactNumber(n: Long): String = when {
    n >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", n / 1e9).replace(".0B", "B")
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1e6).replace(".0M", "M")
    n >= 1_000 -> String.format(Locale.US, "%.1fK", n / 1e3).replace(".0K", "K")
    else -> n.toString()
}
