package com.nekko.android.ui.settings

import androidx.compose.ui.platform.LocalResources
import androidx.annotation.StringRes
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag

import com.nekko.protocol.RouteReport

import android.content.Intent

import android.content.ClipData
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.BuildConfig
import com.nekko.android.connection.TailnetStatus
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ConnectionAdvice
import com.nekko.protocol.ConnectionLog
import com.nekko.android.connection.RoutePolicy
import com.nekko.protocol.Pairing
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import com.nekko.protocol.RouteSupervisor
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Settings → Connection status: how this phone reaches the active computer,
 * what to try when it can't, and what happened since the app started. The log
 * is memory only and holds no rooms, keys or chat content, so it can be copied
 * into a bug report. Same as the iPhone app's Connection screen.
 */
@Composable
fun ConnectionStatusSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val state by deps.repo.state.collectAsStateWithLifecycle()
    val log by deps.repo.connectionLog.collectAsStateWithLifecycle()
    val c = state.active ?: return
    var tailnet by remember { mutableStateOf(TailnetStatus.phoneOnTailnet()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tailnet = TailnetStatus.phoneOnTailnet() }
    // The route in use or being dialed (AN-28); the pairing's relay before the first dial.
    val inUse = state.route ?: c.relayUrl
    val others = remember(c.relayUrl, c.alts, inUse) { RouteSupervisor.order(listOf(c.relayUrl) + c.alts).filter { it != inUse } }
    val advice = ConnectionAdvice.advise(inUse, c.name, state.conn, state.denied, state.connDetail, tailnet, BuildConfig.DEBUG)
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val copiedText = stringResource(R.string.settings_copied)
    val scope = rememberCoroutineScope()

    SectionHeader(stringResource(R.string.settings_connection_status))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Fact(stringResource(R.string.settings_fact_computer), c.name)
            HorizontalDivider(color = p.line)
            Fact(stringResource(R.string.settings_fact_route), routeLabel(RelayRoute.of(inUse)))
            HorizontalDivider(color = p.line)
            Fact(stringResource(R.string.settings_fact_relay), Pairing.relayHost(inUse))
            HorizontalDivider(color = p.line)
            if (others.isNotEmpty()) {
                val res = LocalResources.current
                val names = RelayRoute.entries.associateWith { routeLabel(it) }
                Fact(stringResource(R.string.settings_fact_other_routes), others.joinToString(", ") { r ->
                    res.getString(
                        if (RoutePolicy.allowed(r)) R.string.settings_route_other else R.string.settings_route_other_unused,
                        names.getValue(RelayRoute.of(r)), Pairing.relayHost(r),
                    )
                })
                HorizontalDivider(color = p.line)
            }
            Fact(stringResource(R.string.settings_fact_status), stringResource(stateName(state.conn)))
            HorizontalDivider(color = p.line)
            Fact(stringResource(R.string.settings_fact_tailscale), if (tailnet) stringResource(R.string.settings_connected) else stringResource(R.string.settings_off))
        }
        if (advice.isNotEmpty()) {
            Text(
                stringResource(R.string.settings_what_to_try), style = MaterialTheme.typography.titleSmall, color = p.ink,
                modifier = Modifier.padding(top = 14.dp, start = 4.dp).semantics { heading() },
            )
            NCard(Modifier.padding(top = 6.dp)) {
                advice.forEachIndexed { i, a ->
                    if (i > 0) HorizontalDivider(color = p.line)
                    Text(a, style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.padding(12.dp))
                }
            }
            if (state.conn != RelayState.DENIED) TextButton(onClick = { deps.repo.reconnect() }) { Text(stringResource(R.string.settings_try_again_now)) }
        }
        // IO-21: each route checked in turn on a socket of its own, never the live one.
        val checks by deps.repo.checks.collectAsStateWithLifecycle()
        val checking by deps.repo.checking.collectAsStateWithLifecycle()
        Text(
            stringResource(R.string.settings_routes), style = MaterialTheme.typography.titleSmall, color = p.ink,
            modifier = Modifier.padding(top = 14.dp, start = 4.dp).semantics { heading() },
        )
        if (checks.isNotEmpty()) {
            NCard(Modifier.padding(top = 6.dp).testTag("connection.checks")) {
                checks.forEachIndexed { i, r ->
                    if (i > 0) HorizontalDivider(color = p.line)
                    RouteReportRow(r)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                enabled = !checking,
                onClick = { scope.launch { deps.repo.runChecks() } },
                modifier = Modifier.testTag("connection.checkRoutes"),
            ) { Text(if (checking) stringResource(R.string.settings_checking) else stringResource(R.string.settings_check_routes)) }
            val shareTitle = stringResource(R.string.settings_share_diagnostics)
            TextButton(
                onClick = {
                    val app = "Nekko Agent for Android ${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}, ${Build.MODEL})"
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, "Nekko Agent connection diagnostics")
                        .putExtra(Intent.EXTRA_TEXT, deps.repo.diagnosticsText(app))
                    context.startActivity(Intent.createChooser(send, shareTitle))
                },
                modifier = Modifier.testTag("connection.shareDiagnostics"),
            ) { Text(shareTitle) }
        }
        Text(
            stringResource(R.string.settings_check_routes_footer, c.name),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkSoft,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
        Text(
            stringResource(R.string.settings_since_started), style = MaterialTheme.typography.titleSmall, color = p.ink,
            modifier = Modifier.padding(top = 14.dp, start = 4.dp).semantics { heading() },
        )
        NCard(Modifier.padding(top = 6.dp)) {
            if (log.isEmpty()) Text(stringResource(R.string.settings_nothing_yet), color = p.inkSoft, modifier = Modifier.padding(12.dp))
            log.asReversed().forEachIndexed { i, e ->
                if (i > 0) HorizontalDivider(color = p.line)
                LogRow(e)
            }
        }
        TextButton(
            enabled = log.isNotEmpty(),
            onClick = {
                val text = deps.repo.connectionLogText()
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Connection log", text))) }
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, copiedText, Toast.LENGTH_SHORT).show()
            },
        ) { Text(stringResource(R.string.settings_copy_log)) }
        Text(
            stringResource(R.string.settings_e2e_footer),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkSoft,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
        )
    }
}

/** One route's checks: its kind and host, then each step with its time and what it found. */
@Composable
private fun RouteReportRow(r: RouteReport) {
    val p = Nekko.palette
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("${routeLabel(r.kind)} · ${r.host}", style = MaterialTheme.typography.bodyMedium, color = p.ink)
        for ((nameRes, step) in listOf(R.string.settings_step_dns to r.dns, R.string.settings_step_tcp to r.tcp, R.string.settings_step_hello to r.hello)) {
            val name = stringResource(nameRes)
            val text = when {
                step == null -> stringResource(if (r.dns == null) R.string.settings_step_checking else R.string.settings_step_skipped, name)
                else -> stringResource(if (step.ok) R.string.settings_step_ok else R.string.settings_step_failed, name) +
                    (step.ms?.let { " · $it ms" } ?: "") + (step.detail?.let { " · $it" } ?: "")
            }
            Text(text, style = MaterialTheme.typography.bodySmall, color = if (step != null && !step.ok) p.danger else p.inkSoft)
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = p.ink)
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())

@Composable
private fun LogRow(e: ConnectionLog.Entry) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(stateName(e.state)) + if (e.repeats > 1) " ×${e.repeats}" else "", style = MaterialTheme.typography.bodyMedium, color = p.ink)
            val detail = e.denied?.let { stringResource(R.string.settings_refused_wire, it.wire) } ?: e.detail
            if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        Text(TIME.format(e.at), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}

/** [routeName] in the phone's language. */
@Composable
fun routeLabel(r: RelayRoute): String = when (r) {
    RelayRoute.TAILSCALE -> "Tailscale"
    RelayRoute.LAN -> stringResource(R.string.settings_route_lan)
    RelayRoute.LOOPBACK -> stringResource(R.string.settings_route_loopback)
    RelayRoute.INTERNET -> stringResource(R.string.settings_route_internet)
}

/** Same names as the iPhone's `routeName`, in English; on screen use [routeLabel]. */
fun routeName(r: RelayRoute) = when (r) {
    RelayRoute.TAILSCALE -> "Tailscale"
    RelayRoute.LAN -> "Local network"
    RelayRoute.LOOPBACK -> "This device"
    RelayRoute.INTERNET -> "Internet relay"
}

@StringRes
private fun stateName(s: RelayState) = when (s) {
    RelayState.IDLE -> R.string.settings_state_idle
    RelayState.CONNECTING -> R.string.settings_state_connecting
    RelayState.ONLINE -> R.string.settings_state_online
    RelayState.OFFLINE -> R.string.settings_state_offline
    RelayState.DENIED -> R.string.settings_state_denied
}
