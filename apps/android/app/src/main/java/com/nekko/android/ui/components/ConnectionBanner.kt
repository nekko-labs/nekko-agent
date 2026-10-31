package com.nekko.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.nekko.android.ui.security.SafetyExitDialogs
import com.nekko.android.ui.security.SafetyExitMenuItems
import com.nekko.android.ui.security.SafetyExits
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.DenyReason
import com.nekko.protocol.Pairing
import com.nekko.protocol.RelayHint
import com.nekko.protocol.Tailnet
import com.nekko.android.connection.TailnetStatus
import androidx.compose.runtime.remember
import com.nekko.android.BuildConfig
import com.nekko.protocol.RelayState

/**
 * What a refused phone should do. REVOKED names the steps on the computer: a
 * fresh QR re-admits a removed phone; a computer from before that change only
 * lets it back after Sign out all phones (formerly Rotate secret), so that is the fallback.
 */
fun deniedCopy(reason: DenyReason?): String = when (reason) {
    DenyReason.REVOKED -> "This phone was removed on your computer. There: Settings → Remote access → Pair a device, then scan the new QR here. If it still refuses, use Sign out all phones there first."
    DenyReason.BAD_CODE -> "That pairing code expired or was already used. Scan a fresh QR."
    DenyReason.UNKNOWN_DEVICE -> "Your computer doesn’t know this phone yet. Scan a pairing QR."
    DenyReason.KICKED -> "Your computer disconnected this phone. Pair it again."
    DenyReason.BAD_KEY -> "Your computer has a new pairing key. Pair this phone again: on the computer, Settings → Remote access → Pair a device, then scan the new QR here."
    DenyReason.UPDATE_REQUIRED -> "Your computer only accepts phones on the newest Nekko Agent. Update this app to connect to it."
    DenyReason.INVALID, null -> "Pairing failed. Scan a fresh QR on your computer."
}

/**
 * One line saying whether your computer is reachable, and what to do if not.
 * With [exits], its ⋮ menu holds the safety exits (SK-8), one tap away while
 * a chat runs, and what they did is said under it.
 */
@Composable
fun ConnectionBanner(
    s: ComputersState,
    onPair: () -> Unit,
    onComputers: () -> Unit,
    modifier: Modifier = Modifier,
    exits: SafetyExits? = null,
) {
    val active = s.active
    if (active == null) {
        // Signed out of the last computer: the outcome still has to be said.
        exits?.outcome?.let { (text, tone) -> Notice(text, tone, modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
        return
    }
    val p = Nekko.palette
    // This phone stopped remote access: the computer kicked every phone, which is not a reason to pair again.
    val stopped = s.remoteStoppedAt != null
    val denied = !stopped && (s.denied != null || s.conn == RelayState.DENIED)
    // Pairing again can't help an app that is too old for the computer.
    val repair = denied && s.denied != DenyReason.UPDATE_REQUIRED
    // The route in use or being dialed (AN-28): one of the computer's addresses.
    val route = s.route ?: active.relayUrl
    // An address the phone can never reach: say why instead of "Connecting…" forever.
    val hint = RelayHint.problem(route, BuildConfig.DEBUG)
    // A tailnet relay with Tailscale off on this phone: say so (re-read on each state change).
    val tailnetHint = remember(s.conn, route) {
        if (s.conn == RelayState.ONLINE) null else Tailnet.hint(route, TailnetStatus.phoneOnTailnet(), active.name)
    }
    val (tone, line) = when {
        stopped && s.conn != RelayState.ONLINE ->
            Tone.WARNING to "You stopped remote access on ${active.name}. Turn it on there (Settings → Remote access), then tap here to reconnect."
        denied -> Tone.DANGER to deniedCopy(s.denied)
        s.conn == RelayState.ONLINE -> Tone.SUCCESS to "${active.name} is online"
        hint != null -> Tone.DANGER to RelayHint.message(hint, active.name)
        tailnetHint != null -> Tone.WARNING to tailnetHint
        s.conn == RelayState.OFFLINE -> Tone.WARNING to "${active.name} is offline. Open Nekko Agent on it."
        else -> Tone.WARNING to "Connecting to ${active.name}…"
    }
    var menu by remember { mutableStateOf(false) }
    Column(modifier) {
        Row(
            Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(p.surface)
                .border(1.dp, p.line, RoundedCornerShape(12.dp))
                .clickable(
                    role = Role.Button,
                    onClickLabel = when {
                        stopped && exits != null -> "Reconnect"
                        repair -> "Pair again"
                        else -> "Manage computers"
                    },
                ) {
                    when {
                        stopped && exits != null -> exits.reconnect()
                        repair -> onPair()
                        else -> onComputers()
                    }
                }
                .heightIn(min = 48.dp)
                .padding(start = 16.dp, end = if (exits != null) 4.dp else 16.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Dot(tone)
            Column(Modifier.weight(1f)) {
                Text(line, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = if (hint != null || denied) 5 else 2, overflow = TextOverflow.Ellipsis)
                if (s.conn == RelayState.ONLINE && !denied) {
                    Text(
                        "End-to-end encrypted via ${Pairing.relayHost(route)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                    )
                }
            }
            Icon(
                if (repair) Icons.Filled.QrCode2 else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = p.inkFaint,
                modifier = Modifier.size(18.dp),
            )
            if (exits != null) {
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "Safety options for ${active.name}", tint = p.inkSoft)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        SafetyExitMenuItems(s, exits, onPicked = { menu = false })
                    }
                }
            }
        }
        exits?.outcome?.let { (msg, msgTone) -> Notice(msg, msgTone, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
    }
    exits?.let { SafetyExitDialogs(it, active.name) }
}
