package com.nekko.android.ui.screens

import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
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
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
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
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.settings_back)) } },
                actions = { IconButton(onClick = onRefresh) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.settings_refresh)) } },
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

@Composable
private fun ago(ms: Long): String {
    val now = System.currentTimeMillis()
    if (now - ms in 0 until DateUtils.MINUTE_IN_MILLIS) return stringResource(R.string.settings_just_now)
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
    val computer = c.active?.name ?: stringResource(R.string.your_computer)
    val res = LocalResources.current
    val pausedNote = stringResource(R.string.settings_automations_paused_on, computer)
    val noneYet = stringResource(R.string.settings_no_automations, computer)
    val tasksLabel = stringResource(R.string.settings_tasks)
    val workflowsLabel = stringResource(R.string.settings_workflows)
    LaunchedEffect(a) { a.load() }
    fun run(id: String, call: suspend () -> Unit) {
        running = id
        scope.launch {
            try {
                call()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = e.message ?: res.getString(R.string.settings_couldnt_run)
            } finally {
                running = null
            }
        }
    }
    Page(stringResource(R.string.settings_automations), onBack, onRefresh = { scope.launch { a.load() } }) { pad ->
        LazyColumn(Modifier.fillMaxSize().testTag("automations.list"), contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (c.pcSettings.automationsPaused) item { Notice(pausedNote, Tone.WARNING) }
            s.error?.let { item { Notice(it, Tone.DANGER) } }
            if (s.loaded && s.error == null && s.isEmpty) {
                item { Text(noneYet, color = p.inkSoft) }
            }
            if (s.tasks.isNotEmpty()) {
                item { Label(tasksLabel) }
                items(s.tasks, key = { "t:${it.id}" }) { t ->
                    AutomationRow(
                        t.title, t.cadence { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(it)) },
                        taskStatus(t), t.lastResult, t.lastRunAt, started = t.id in s.started, busy = running == t.id,
                    ) { run(t.id) { a.runTask(t.id) } }
                }
            }
            if (s.workflows.isNotEmpty()) {
                item { Label(workflowsLabel) }
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
            title = { Text(stringResource(R.string.settings_couldnt_run_title)) },
            text = { Text(m) },
            confirmButton = { TextButton(onClick = { failed = null }) { Text(stringResource(R.string.settings_ok)) } },
        )
    }
}

@Composable
private fun taskStatus(t: AutomationTask): Pair<String, Color>? {
    val p = Nekko.palette
    return when {
        t.failed -> stringResource(R.string.settings_last_run_failed) to p.danger
        t.paused -> stringResource(R.string.settings_paused) to p.inkSoft
        t.status == "done" -> stringResource(R.string.settings_task_done) to p.success
        else -> null
    }
}

@Composable
private fun workflowStatus(w: AutomationWorkflow): Pair<String, Color>? {
    val p = Nekko.palette
    return when (w.lastStatus) {
        "success" -> stringResource(R.string.settings_last_run_passed) to p.success
        "failure" -> stringResource(R.string.settings_last_run_failed) to p.danger
        "running", "queued" -> stringResource(R.string.settings_running) to p.running
        "cancelled" -> stringResource(R.string.settings_last_run_cancelled) to p.inkSoft
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
                    val description = stringResource(if (started) R.string.settings_started_cd else R.string.settings_run_now_cd, title)
                    TextButton(
                        onClick = onRun,
                        modifier = Modifier.testTag("automations.run").semantics { contentDescription = description },
                    ) { Text(if (started) stringResource(R.string.settings_started) else stringResource(R.string.settings_run_now), color = if (started) p.inkSoft else p.accent, fontWeight = FontWeight.SemiBold) }
                }
            }
        }
        status?.let { (text, color) -> Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = color) }
        lastRun?.let { Text(stringResource(R.string.settings_last_run, ago(it)), style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
        result?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 4) }
    }
}

/** What the computer's providers have used, and each plan's limits (AN-29, the iPhone's `UsageView`). Read only. */
@Composable
fun UsageScreen(
    repo: ComputersRepository,
    onBack: () -> Unit,
    /** Where each computer's last numbers are kept for when it is offline. */
    phonePrefs: com.nekko.android.data.PhonePrefs? = null,
    /** This phone's own chats, whose usage is a place of its own; null leaves it out. */
    phone: com.nekko.android.phone.PhoneChats? = null,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    // Every paired computer, in the app's order, then this phone (#2114, the iPhone's #1773).
    val u = remember(repo, phone) {
        com.nekko.android.beyond.UsageByPlaceController(
            computers = { repo.state.value.computers.map { it.id to it.name } },
            callerFor = repo::callerFor,
            phone = { phone?.state?.value?.takeIf { it.ready }?.usage },
            prefs = phonePrefs,
        )
    }
    val s by u.state.collectAsStateWithLifecycle()
    val state by repo.state.collectAsStateWithLifecycle()
    LaunchedEffect(u) {
        runCatching { phone?.load() }
        u.load()
    }
    Page(stringResource(R.string.settings_usage), onBack, onRefresh = { scope.launch { u.load() } }) { pad ->
        UsagePlacesList(s.places, s.loaded, s.loading, iconOf = { id -> state.computers.firstOrNull { it.id == id }?.icon }, pad = pad)
    }
}

/**
 * Usage by place (#2114): All places when there is more than one, then each computer (its icon,
 * Offline in the heading when it is), then this phone. In each: subscriptions with their limits,
 * then API use, then recent days, folded.
 */
@Composable
internal fun UsagePlacesList(
    places: List<com.nekko.protocol.UsagePlace>,
    loaded: Boolean,
    loading: Boolean,
    iconOf: (String) -> String?,
    pad: PaddingValues = PaddingValues(16.dp),
) {
    val p = Nekko.palette
    val money = remember { NumberFormat.getCurrencyInstance(Locale.US).apply { currency = Currency.getInstance("USD") } }
    val compact = { n: Long -> compactNumber(n) }
    val res = LocalResources.current
    var openDays by remember { mutableStateOf(setOf<String>()) }
    run {
        LazyColumn(Modifier.fillMaxSize().testTag("usage.view"), contentPadding = pad, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (places.size > 1) item(key = "all") {
                val t = com.nekko.protocol.UsageTotals.of(places)
                Label(stringResource(R.string.usage_all_places))
                Card {
                    Line(stringResource(R.string.settings_tokens), compact(t.tokens))
                    Line(stringResource(R.string.usage_subscription_tokens), compact(t.subscriptionTokens))
                    Line(stringResource(R.string.usage_api_tokens), compact(t.apiTokens))
                    Line(stringResource(R.string.usage_api_spend), money.format(t.apiCost))
                    if (t.offline > 0) Text(stringResource(R.string.usage_offline_counted, t.offline), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                }
            }
            items(places, key = { "place:${it.id}" }) { place ->
                val phonePlace = place.kind == com.nekko.protocol.UsagePlace.Kind.PHONE
                val name = if (phonePlace) stringResource(R.string.usage_this_phone) else place.name
                Row(Modifier.padding(top = 8.dp).testTag("usage.place.${place.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!phonePlace) com.nekko.android.ui.components.ComputerTileIcon(iconOf(place.id), 16.dp, p.inkSoft)
                    Label(if (place.online) name else stringResource(R.string.usage_offline_heading, name))
                }
                Card {
                    if (!place.online) Text(
                        when {
                            place.error != null -> stringResource(R.string.usage_error_last, place.error!!)
                            place.summary != null || place.plans.isNotEmpty() -> stringResource(R.string.usage_offline_last)
                            else -> stringResource(R.string.usage_offline_never)
                        },
                        style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
                    )
                    // The place's total first, as the one-computer screen had it.
                    place.summary?.let { Line(stringResource(R.string.settings_tokens), compact(it.totalTokens)) }
                    // Subscriptions first: each plan with its limits, then the models that bill to a plan.
                    if (place.plans.isNotEmpty() || place.subscriptionModels.isNotEmpty()) {
                        Sub(stringResource(R.string.usage_subscriptions))
                        place.plans.forEach { plan ->
                            Text(plan.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = p.ink)
                            if (plan.limits.windows.isEmpty()) Text(stringResource(R.string.settings_no_limits), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                            plan.limits.windows.forEach { LimitBar(it) }
                        }
                        place.subscriptionModels.forEach { m -> Line(m.model, res.getString(R.string.settings_plan_tokens, compact(m.tokens))) }
                    }
                    // Then pay-per-token use: by provider on this phone, tokens only; with cost on a computer.
                    val api = place.apiGroups
                    if (api.isNotEmpty()) {
                        Sub(stringResource(R.string.usage_api))
                        api.forEach { g ->
                            g.label?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = p.ink) }
                            g.models.forEach { m -> Line(m.model, if (place.priced) "${compact(m.tokens)} · ${money.format(m.cost)}" else compact(m.tokens)) }
                        }
                        place.apiCost?.let { Line(stringResource(R.string.usage_api_spend), money.format(it)) }
                        if (!place.priced) Text(stringResource(R.string.usage_tokens_only), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
                    }
                    val days = place.summary?.days.orEmpty()
                    if (days.isNotEmpty()) {
                        val open = place.id in openDays
                        TextButton(onClick = { openDays = if (open) openDays - place.id else openDays + place.id }, modifier = Modifier.testTag("usage.days.${place.id}")) {
                            Text(stringResource(R.string.settings_recent_days) + if (open) " ▴" else " ▾")
                        }
                        if (open) days.reversed().forEach { d -> Line(d.date, if (place.priced) "${compact(d.tokens)} · ${money.format(d.cost)}" else compact(d.tokens)) }
                    }
                    if (place.online && place.isEmpty) Text(stringResource(R.string.settings_no_usage_recorded), color = p.inkSoft)
                }
            }
            if (loaded && places.isEmpty()) item { Text(stringResource(R.string.settings_no_usage_recorded), color = p.inkSoft) }
            if (loading && !loaded) item { CircularProgressIndicator(color = p.accent) }
        }
    }
}

/** A part of a place: Subscriptions, API. */
@Composable
private fun Sub(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = Nekko.palette.inkFaint, modifier = Modifier.padding(top = 4.dp).semantics { heading() })
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
            Text(stringResource(R.string.settings_used_pct, Math.round(w.usedPercent)), style = MaterialTheme.typography.bodyMedium, color = color)
        }
        LinearProgressIndicator(progress = { (w.usedPercent / 100).toFloat() }, color = color, trackColor = p.line, modifier = Modifier.fillMaxWidth())
        w.resetAt?.takeIf { it > 0 }?.let { Text(stringResource(R.string.settings_resets, ago(it)), style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
    }
}

/** 1,234 → 1.2K, 3,400,000 → 3.4M. */
internal fun compactNumber(n: Long): String = when {
    n >= 1_000_000_000 -> String.format(Locale.US, "%.1fB", n / 1e9).replace(".0B", "B")
    n >= 1_000_000 -> String.format(Locale.US, "%.1fM", n / 1e6).replace(".0M", "M")
    n >= 1_000 -> String.format(Locale.US, "%.1fK", n / 1e3).replace(".0K", "K")
    else -> n.toString()
}
