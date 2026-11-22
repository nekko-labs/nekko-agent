package com.nekko.android.ui.screens

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.connection.TailnetStatus
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.DEFAULT_COMPUTER_NAME
import com.nekko.android.ui.components.openTailscale
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayState
import kotlinx.coroutines.delay

/**
 * Right after pairing over Tailscale (and from Settings → Connection, any time): the steps that
 * are left, each checked live (#2856, the iPhone's #2720).
 *
 * 1. Tailscale is on on this phone: a tailnet address is up ([TailnetStatus]).
 * 2. The computer answers: its connection is online.
 * 3. Keep it working away from home: Tailscale's *Always-on VPN* in Android's VPN settings. Android
 *    doesn't tell an app which VPN is always-on, so this step is advice, never ticked.
 *
 * The checks run again when the app comes back and every 2 seconds while open, so turning Tailscale
 * on shows here without a tap; the computer is dialed again the moment Tailscale comes up.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TailscaleSetupSheet(repo: ComputersRepository, computerId: String, onDone: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val state by repo.state.collectAsStateWithLifecycle()
    val conn = if (state.activeId == computerId) state.conn else state.peers[computerId]?.conn ?: RelayState.IDLE
    val name = state.computers.firstOrNull { it.id == computerId }?.name?.takeIf { it != DEFAULT_COMPUTER_NAME }
        ?: stringResource(R.string.tailscale_your_computer)
    var tailnet by remember { mutableStateOf(TailnetStatus.phoneOnTailnet()) }
    val online = conn == RelayState.ONLINE
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        tailnet = TailnetStatus.phoneOnTailnet()
        if (!online) repo.reconnect(computerId)
    }
    LaunchedEffect(computerId) {
        while (true) {
            delay(2_000)
            val now = TailnetStatus.phoneOnTailnet()
            if (now && !tailnet && repo.state.value.let { s -> (if (s.activeId == computerId) s.conn else s.peers[computerId]?.conn) != RelayState.ONLINE }) repo.reconnect(computerId)
            tailnet = now
        }
    }
    ModalBottomSheet(onDismissRequest = onDone, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.paper) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 16.dp).testTag("tailscaleSetup"),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.tailscale_title), style = MaterialTheme.typography.titleLarge, color = p.ink, modifier = Modifier.weight(1f).semantics { heading() })
                TextButton(onClick = onDone, modifier = Modifier.heightIn(min = 48.dp).testTag("tailscaleSetup.done")) {
                    Text(stringResource(if (tailnet && online) R.string.tailscale_done else R.string.tailscale_later), color = p.accent)
                }
            }
            Text(stringResource(R.string.tailscale_intro, name), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
            Step(1, tailnet,
                stringResource(if (tailnet) R.string.tailscale_on_title else R.string.tailscale_off_title),
                stringResource(if (tailnet) R.string.tailscale_on_detail else R.string.tailscale_off_detail))
            if (!tailnet) {
                OutlinedButton(onClick = { openTailscale(context) }, modifier = Modifier.padding(start = 38.dp).heightIn(min = 48.dp).testTag("tailscaleSetup.open")) {
                    Text(stringResource(R.string.tailscale_open), color = p.accent)
                }
            }
            Step(2, online,
                if (online) stringResource(R.string.tailscale_answers, name) else stringResource(R.string.tailscale_waiting, name),
                when {
                    online -> stringResource(R.string.tailscale_answers_detail)
                    conn == RelayState.DENIED -> stringResource(R.string.tailscale_denied_detail)
                    !tailnet -> stringResource(R.string.tailscale_after_on_detail)
                    else -> stringResource(R.string.tailscale_check_computer_detail)
                })
            Step(3, null, stringResource(R.string.tailscale_always_title), stringResource(R.string.tailscale_always_detail))
            OutlinedButton(
                onClick = { runCatching { context.startActivity(Intent(Settings.ACTION_VPN_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
                modifier = Modifier.padding(start = 38.dp).heightIn(min = 48.dp).testTag("tailscaleSetup.vpnSettings"),
            ) { Text(stringResource(R.string.tailscale_vpn_settings), color = p.accent) }
            Text(stringResource(R.string.tailscale_cloud_soon), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
    }
}

/** One step: a tick when done, else its number. [ok] null is advice Android can't check. */
@Composable
private fun Step(n: Int, ok: Boolean?, title: String, detail: String) {
    val p = Nekko.palette
    val value = stringResource(if (ok == true) R.string.tailscale_step_done else R.string.tailscale_step_not_done)
    Row(
        // The tag before clearAndSetSemantics, which would drop it.
        Modifier.fillMaxWidth().testTag("tailscaleSetup.step$n").clearAndSetSemantics { contentDescription = if (ok == null) "$title. $detail" else "$title. $detail. $value" },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(26.dp).background(if (ok == true) p.success else p.surface2, CircleShape), contentAlignment = Alignment.Center) {
            if (ok == true) Icon(Icons.Filled.Check, contentDescription = null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(16.dp))
            else Text("$n", style = MaterialTheme.typography.labelMedium, color = p.inkSoft, fontWeight = FontWeight.SemiBold)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = p.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
    }
}
