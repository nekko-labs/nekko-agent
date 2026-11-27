package com.nekko.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.nekko.android.R
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Channels
import com.nekko.protocol.FleetRunnerComputer
import kotlinx.coroutines.delay

/**
 * The organizations' CI runners (decision 0064, the iPhone's FleetRunnersSection), read through
 * this computer while it is the connected one. Shows nothing until a computer reports a runner.
 */
@Composable
fun FleetRunnersSection(repo: ComputersRepository, computerId: String, computerName: String) {
    val p = Nekko.palette
    val link = remember(repo, computerId) { repo.serviceLink(computerId) }
    val s by repo.state.collectAsStateWithLifecycle()
    var computers by remember(computerId) { mutableStateOf(emptyList<FleetRunnerComputer>()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(link, s.activeId, s.conn) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (link.connection() != null) {
                // An older computer, or one with no Cloud account, refuses the channel: keep the section hidden.
                runCatching { link.read(Channels.FLEET_RUNNERS) }.onSuccess { computers = FleetRunnerComputer.list(it) }
                delay(30_000)
            }
        }
    }
    if (link.connection() == null || computers.isEmpty()) return

    SectionHeader(stringResource(R.string.fleet_runners_title))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard(Modifier.testTag("fleetRunners.section")) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                computers.forEachIndexed { i, c ->
                    if (i > 0) HorizontalDivider(color = p.line)
                    Column(Modifier.testTag("fleetRunners.computer"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(if (c.you) stringResource(R.string.fleet_runners_you, c.name) else c.name, style = MaterialTheme.typography.bodyMedium, color = p.ink)
                        if (c.online) {
                            c.lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft) }
                        } else {
                            Text(stringResource(R.string.fleet_runners_offline), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                        }
                    }
                }
            }
        }
        Text(stringResource(R.string.fleet_runners_footer, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp))
    }
}
