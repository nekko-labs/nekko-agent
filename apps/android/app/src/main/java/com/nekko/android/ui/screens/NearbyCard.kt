package com.nekko.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.nekko.android.connection.NearbyBrowser
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Pairing

/**
 * Computers on this Wi-Fi that say they run Nekko Agent (the desktop's
 * *Visible on this network*). A pointer only: their record holds no secrets,
 * so pairing still takes the computer's code. Looks only when asked.
 */
@Composable
fun NearbyCard() {
    val p = Nekko.palette
    val context = LocalContext.current
    val browser = remember { NearbyBrowser(context.applicationContext) }
    DisposableEffect(browser) { onDispose { browser.stop() } }
    val state by browser.state.collectAsState()

    NCard {
        Text("On this network", style = MaterialTheme.typography.titleSmall, color = p.ink)
        state.found.forEach { c ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(Icons.Filled.Computer, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
                Column {
                    Text(c.name, style = MaterialTheme.typography.bodyLarge, color = p.ink)
                    Text(
                        c.relayUrl?.let { "Runs its own relay: ${Pairing.relayHost(it)}" } ?: "On this network",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkSoft,
                    )
                }
            }
        }
        if (state.phase == NearbyBrowser.Phase.LOOKING) {
            Row(
                Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Looking on this network" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                Text("Looking…", color = p.inkSoft)
            }
        } else {
            OutlinedButton(onClick = { browser.start() }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (state.looked || state.found.isNotEmpty()) "Look again" else "Look on this network")
            }
        }
        when {
            state.phase == NearbyBrowser.Phase.FAILED ->
                Notice("Couldn’t look on this network. Check that Wi-Fi is on, then try again.", Tone.DANGER)
            state.looked && state.found.isEmpty() && state.phase == NearbyBrowser.Phase.IDLE -> Text(
                "No computers found. On the computer, turn on Settings → Remote access → Visible on this network. Some Wi-Fi networks (offices, hotels) block this; the code always works.",
                style = MaterialTheme.typography.bodySmall,
                color = p.inkSoft,
            )
        }
        Text(
            "Finding a computer doesn’t pair with it. On the computer you want: Settings → Remote access → Pair a device, then scan its code.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
        )
    }
}
