package com.nekko.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.nekko.protocol.RelayState

fun deniedCopy(reason: DenyReason?): String = when (reason) {
    DenyReason.REVOKED -> "This phone was removed on your computer. Pair it again."
    DenyReason.BAD_CODE -> "That pairing code expired or was already used. Scan a fresh QR."
    DenyReason.UNKNOWN_DEVICE -> "Your computer doesn’t know this phone yet. Scan a pairing QR."
    DenyReason.KICKED -> "Your computer disconnected this phone. Pair it again."
    DenyReason.BAD_KEY -> "The pairing key changed on your computer. Scan a fresh QR."
    DenyReason.INVALID, null -> "Pairing failed. Scan a fresh QR on your computer."
}

/** One line saying whether your computer is reachable, and what to do if not. */
@Composable
fun ConnectionBanner(s: ComputersState, onPair: () -> Unit, onComputers: () -> Unit, modifier: Modifier = Modifier) {
    val active = s.active ?: return
    val p = Nekko.palette
    val denied = s.denied != null || s.conn == RelayState.DENIED
    val (tone, line) = when {
        denied -> Tone.DANGER to deniedCopy(s.denied)
        s.conn == RelayState.ONLINE -> Tone.SUCCESS to "${active.name} is online"
        s.conn == RelayState.OFFLINE -> Tone.WARNING to "${active.name} is offline. Open Nekko Agent on it."
        else -> Tone.WARNING to "Connecting to ${active.name}…"
    }
    Row(
        modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.surface)
            .border(1.dp, p.line, RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClickLabel = if (denied) "Pair again" else "Manage computers") {
                if (denied) onPair() else onComputers()
            }
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Dot(tone)
        Column(Modifier.weight(1f)) {
            Text(line, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (s.conn == RelayState.ONLINE && !denied) {
                Text(
                    "End-to-end encrypted via ${Pairing.relayHost(active.relayUrl)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
            }
        }
        Icon(
            if (denied) Icons.Filled.QrCode2 else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = p.inkFaint,
            modifier = Modifier.size(18.dp),
        )
    }
}
