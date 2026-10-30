package com.nekko.android.ui.settings

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
    val scope = rememberCoroutineScope()

    SectionHeader("Connection status")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            Fact("Computer", c.name)
            HorizontalDivider(color = p.line)
            Fact("Route", routeName(RelayRoute.of(inUse)))
            HorizontalDivider(color = p.line)
            Fact("Relay", Pairing.relayHost(inUse))
            HorizontalDivider(color = p.line)
            if (others.isNotEmpty()) {
                Fact("Other routes", others.joinToString(", ") { r ->
                    "${routeName(RelayRoute.of(r))} (${Pairing.relayHost(r)}${if (RoutePolicy.allowed(r)) "" else ", not used on Android"})"
                })
                HorizontalDivider(color = p.line)
            }
            Fact("Status", stateName(state.conn))
            HorizontalDivider(color = p.line)
            Fact("Tailscale on this phone", if (tailnet) "Connected" else "Off")
        }
        if (advice.isNotEmpty()) {
            Text(
                "What to try", style = MaterialTheme.typography.titleSmall, color = p.ink,
                modifier = Modifier.padding(top = 14.dp, start = 4.dp).semantics { heading() },
            )
            NCard(Modifier.padding(top = 6.dp)) {
                advice.forEachIndexed { i, a ->
                    if (i > 0) HorizontalDivider(color = p.line)
                    Text(a, style = MaterialTheme.typography.bodyMedium, color = p.ink, modifier = Modifier.padding(12.dp))
                }
            }
            if (state.conn != RelayState.DENIED) TextButton(onClick = { deps.repo.reconnect() }) { Text("Try again now") }
        }
        Text(
            "Since the app started", style = MaterialTheme.typography.titleSmall, color = p.ink,
            modifier = Modifier.padding(top = 14.dp, start = 4.dp).semantics { heading() },
        )
        NCard(Modifier.padding(top = 6.dp)) {
            if (log.isEmpty()) Text("Nothing yet.", color = p.inkSoft, modifier = Modifier.padding(12.dp))
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
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
            },
        ) { Text("Copy log") }
        Text(
            "Messages are end-to-end encrypted on every route; the relay sees only sealed frames. The log holds times, states and the relay's host, no keys or messages.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkSoft,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 6.dp),
        )
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
            Text(stateName(e.state) + if (e.repeats > 1) " ×${e.repeats}" else "", style = MaterialTheme.typography.bodyMedium, color = p.ink)
            val detail = e.denied?.let { "Refused: ${it.wire}" } ?: e.detail
            if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        Text(TIME.format(e.at), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}

/** Same names as the iPhone's `routeName`. */
fun routeName(r: RelayRoute) = when (r) {
    RelayRoute.TAILSCALE -> "Tailscale"
    RelayRoute.LAN -> "Local network"
    RelayRoute.LOOPBACK -> "This device"
    RelayRoute.INTERNET -> "Internet relay"
}

private fun stateName(s: RelayState) = when (s) {
    RelayState.IDLE -> "Not connected"
    RelayState.CONNECTING -> "Connecting"
    RelayState.ONLINE -> "Online"
    RelayState.OFFLINE -> "Computer offline"
    RelayState.DENIED -> "Refused"
}
