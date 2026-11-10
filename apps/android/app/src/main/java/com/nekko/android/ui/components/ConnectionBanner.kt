package com.nekko.android.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.QrCode2
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import android.animation.ValueAnimator
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.nekko.android.ui.security.SafetyExitMenuItems
import com.nekko.android.ui.security.SafetyExits
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import com.nekko.protocol.RelayStatus
import androidx.annotation.StringRes
import androidx.compose.ui.res.stringResource
import com.nekko.android.R

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

/** [deniedCopy] as a string resource, in the phone's language (the English above stays for tests). */
@StringRes
fun deniedCopyRes(reason: DenyReason?): Int = when (reason) {
    DenyReason.REVOKED -> R.string.chats_denied_revoked
    DenyReason.BAD_CODE -> R.string.chats_denied_bad_code
    DenyReason.UNKNOWN_DEVICE -> R.string.chats_denied_unknown_device
    DenyReason.KICKED -> R.string.chats_denied_kicked
    DenyReason.BAD_KEY -> R.string.chats_denied_bad_key
    DenyReason.UPDATE_REQUIRED -> R.string.chats_denied_update_required
    DenyReason.INVALID, null -> R.string.chats_denied_invalid
}

/**
 * One line saying whether your computer is reachable, and what to do if not.
 * With [exits], its ⋮ menu holds the safety exits (SK-8), one tap away while
 * a chat runs, and what they did is said under it. The screen draws their
 * quit confirmation (`SafetyExitDialogs`), so it shows wherever the list is scrolled.
 */
@Composable
fun ConnectionBanner(
    s: ComputersState,
    onPair: () -> Unit,
    onComputers: () -> Unit,
    modifier: Modifier = Modifier,
    exits: SafetyExits? = null,
    queuedCount: Int = 0,
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
    val badKey = !stopped && !denied && s.badKey
    // Pairing again can't help an app that is too old for the computer.
    val repair = badKey || (denied && s.denied != DenyReason.UPDATE_REQUIRED)
    // The route in use or being dialed (AN-28): one of the computer's addresses.
    val route = s.route ?: active.relayUrl
    // An address the phone can never reach: say why instead of "Connecting…" forever.
    val hint = RelayHint.problem(route, BuildConfig.DEBUG)
    // A tailnet relay with Tailscale off on this phone: say so (re-read on each state change).
    val tailnetHint = remember(s.conn, route) {
        if (s.conn == RelayState.ONLINE) null else Tailnet.hint(route, TailnetStatus.phoneOnTailnet(), active.name)
    }
    // The relay's name doesn't resolve: the paired address is gone, so say so instead of "Connecting…" forever.
    val hostGone = s.conn == RelayState.CONNECTING && s.connDetail == RelayStatus.HOST_NOT_FOUND
    val (tone, line) = when {
        stopped && s.conn != RelayState.ONLINE ->
            Tone.WARNING to stringResource(R.string.chats_banner_stopped, active.name)
        denied -> Tone.DANGER to stringResource(deniedCopyRes(s.denied))
        badKey -> Tone.DANGER to stringResource(deniedCopyRes(DenyReason.BAD_KEY))
        s.conn == RelayState.ONLINE -> Tone.SUCCESS to stringResource(R.string.chats_banner_online, active.name)
        hint != null -> Tone.DANGER to RelayHint.message(hint, active.name)
        tailnetHint != null -> Tone.WARNING to tailnetHint
        hostGone -> Tone.DANGER to stringResource(R.string.chats_banner_host_not_found, Pairing.relayHost(route), active.name)
        s.conn == RelayState.OFFLINE -> Tone.WARNING to stringResource(R.string.chats_banner_offline, active.name)
        else -> Tone.WARNING to stringResource(R.string.chats_banner_connecting, active.name)
    }
    val clickLabel = when {
        stopped && exits != null -> stringResource(R.string.chats_reconnect)
        repair -> stringResource(R.string.chats_pair_again)
        else -> stringResource(R.string.chats_manage_computers)
    }
    val specialError = stopped || denied || badKey || hint != null || tailnetHint != null || hostGone
    val pulse = reconnectPulse(s.conn, specialError, systemAnimationsEnabled())
    var menu by remember { mutableStateOf(false) }
    Column(modifier) {
        Row(
            Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .fillMaxWidth()
                .clickable(
                    role = Role.Button,
                    onClickLabel = clickLabel,
                ) {
                    when {
                        stopped && exits != null -> exits.reconnect()
                        repair -> onPair()
                        else -> onComputers()
                    }
                }
                .heightIn(min = 48.dp)
                .padding(start = 4.dp, end = if (exits != null) 0.dp else 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ConnectionDot(tone, pulse)
                    Text(line, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, maxLines = if (hint != null || denied || badKey || hostGone) 5 else 2, overflow = TextOverflow.Ellipsis)
                }
                if (queuedCount > 0 && s.conn != RelayState.ONLINE) {
                    Text(
                        if (queuedCount == 1) stringResource(R.string.chats_outbox_note_one, active.name)
                        else stringResource(R.string.chats_outbox_note_other, queuedCount, active.name),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                        modifier = Modifier.padding(start = 16.dp).testTag("chats.outboxNote"),
                    )
                }
                if (s.conn == RelayState.ONLINE && !denied) {
                    Text(
                        stringResource(R.string.chats_encrypted_via, Pairing.relayHost(route)),
                        modifier = Modifier.padding(start = 16.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                    )
                }
            }
            Icon(
                if (repair) Icons.Outlined.QrCode2 else Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = p.inkFaint,
                modifier = Modifier.size(18.dp),
            )
            if (exits != null) {
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.chats_safety_options, active.name), tint = p.inkSoft)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        SafetyExitMenuItems(s, exits, onPicked = { menu = false })
                    }
                }
            }
        }
        exits?.outcome?.let { (msg, msgTone) -> Notice(msg, msgTone, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
    }
}

/** Only an ordinary reconnect pulses, never an offline, refused or repair state. */
internal fun reconnectPulse(conn: RelayState, specialError: Boolean, animationsEnabled: Boolean): Boolean =
    animationsEnabled && !specialError && conn in setOf(RelayState.CONNECTING, RelayState.IDLE)

@Composable
private fun ConnectionDot(tone: Tone, pulse: Boolean) {
    val opacity = if (pulse) {
        val transition = rememberInfiniteTransition(label = "reconnecting")
        val alpha by transition.animateFloat(
            initialValue = 0.55f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
            label = "reconnecting dot",
        )
        alpha
    } else 1f
    Dot(tone, Modifier.alpha(opacity).testTag("connection.dot"))
}

/** Observe Remove animations live, including a change while this screen is open. */
@Composable
private fun systemAnimationsEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    var enabled by remember(resolver) { mutableStateOf(ValueAnimator.areAnimatorsEnabled()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { enabled = ValueAnimator.areAnimatorsEnabled() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        enabled = ValueAnimator.areAnimatorsEnabled()
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return enabled
}
