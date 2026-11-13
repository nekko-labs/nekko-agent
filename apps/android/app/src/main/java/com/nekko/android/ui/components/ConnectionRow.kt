package com.nekko.android.ui.components

import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.nekko.android.BuildConfig
import com.nekko.android.R
import com.nekko.android.connection.ConnectionNote
import com.nekko.android.connection.ConnectionNote.Action
import com.nekko.android.connection.ConnectionNote.Tone
import com.nekko.android.connection.ConnectionNotes
import com.nekko.android.connection.Msg
import com.nekko.android.connection.Names
import com.nekko.android.connection.TailnetStatus
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.security.SafetyExitMenuItems
import com.nekko.android.ui.security.SafetyExits
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayState
import java.text.DateFormat
import java.util.Date

/** The Tailscale app's package, to open it (or its Play Store page). */
private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"

/** [Msg] in words, in the phone's language. */
fun Msg.text(res: Resources): String = when (this) {
    is Msg.Text -> text
    is Msg.Res -> res.getString(this.res, *args.map { if (it is Names) joinNames(it.names, res) else it }.toTypedArray())
}

/** "Studio", "Studio and Gomi", "Studio, Gomi and Laptop". */
fun joinNames(names: List<String>, res: Resources): String =
    if (names.size <= 1) names.firstOrNull().orEmpty()
    else res.getString(R.string.conn_names_and, names.dropLast(1).reduce { head, next -> res.getString(R.string.conn_names_list, head, next) }, names.last())

/**
 * One slim row of every paired computer and its connection: a dot and a name, one word when
 * something is wrong, and (tapped) one line with the fix under it. Tailscale leads the row when
 * it is what keeps computers away. The iPhone's connection strip
 * (spec/phone/iphone-connection-strip.md); replaces the connection, fleet and protocol banners.
 * The safety exits (SK-8) sit behind the active computer's ⋮ and what they did is said under the row.
 */
@Composable
fun ConnectionRow(
    s: ComputersState,
    waiting: Int,
    onPair: () -> Unit,
    onDetails: () -> Unit,
    onRetry: (String) -> Unit,
    onTryAgain: (String) -> Unit,
    modifier: Modifier = Modifier,
    exits: SafetyExits? = null,
) {
    val context = LocalContext.current
    // Re-read on each state change: Tailscale's tunnel comes and goes without the app being told.
    val tailscaleOn = remember(s.conn, s.peers.mapValues { it.value.conn }, s.route) { TailnetStatus.phoneOnTailnet() }
    val notes = ConnectionNotes.make(ConnectionNotes.facts(s, waiting, BuildConfig.DEBUG), tailscaleOn) { at ->
        DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))
    }
    ConnectionRow(
        notes, s, modifier, exits,
        onAction = { note, action ->
            when (action) {
                Action.RETRY -> onRetry(note.id)
                Action.TRY_AGAIN -> onTryAgain(note.id)
                Action.PAIR_AGAIN -> onPair()
                Action.OPEN_TAILSCALE -> openTailscale(context)
                Action.DETAILS -> onDetails()
            }
        },
    )
}

/** The row for [notes], whatever made them (tests and screenshots pass their own). */
@Composable
fun ConnectionRow(
    notes: List<ConnectionNote>,
    s: ComputersState?,
    modifier: Modifier = Modifier,
    exits: SafetyExits? = null,
    initiallyOpen: String? = null,
    onAction: (ConnectionNote, Action) -> Unit = { _, _ -> },
) {
    val outcome = exits?.outcome
    if (notes.isEmpty() && outcome == null) return
    val p = Nekko.palette
    var open by remember { mutableStateOf(initiallyOpen) }
    val shown = notes.firstOrNull { it.id == open && it.opens }
    Column(modifier.fillMaxWidth().testTag("connection-strip")) {
        if (notes.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                notes.forEach { n -> Item(n, selected = shown?.id == n.id, onClick = { open = if (shown?.id == n.id) null else n.id }) }
            }
        }
        AnimatedVisibility(
            visible = shown != null,
            enter = expandVertically(tween(200)) + fadeIn(tween(200)),
            exit = shrinkVertically(tween(200)) + fadeOut(tween(200)),
        ) {
            // Keep the last opened note while the line closes.
            val last = remember { arrayOfNulls<ConnectionNote>(1) }
            shown?.let { last[0] = it }
            last[0]?.let { Detail(it, s, exits, onAction) }
        }
        exits?.outcome?.let { (msg, tone) -> Notice(msg, tone, Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
    }
}

@Composable
private fun Item(n: ConnectionNote, selected: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    val res = LocalResources.current
    val word = n.word?.text(res)
    val label = @Composable {
        Row(
            Modifier
                .heightIn(min = 32.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (selected) p.ink.copy(alpha = 0.07f) else Color.Transparent)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (n.isTailscale) {
                Icon(Icons.Outlined.WifiOff, contentDescription = null, tint = p.warning, modifier = Modifier.size(14.dp))
            } else {
                StateDot(n.tone)
                Text(n.name.orEmpty(), style = MaterialTheme.typography.labelLarge, color = if (selected) p.ink else p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (word != null) {
                Text(
                    word, style = MaterialTheme.typography.labelLarge, maxLines = 1,
                    fontWeight = if (n.isTailscale) FontWeight.Medium else FontWeight.Normal,
                    color = wordColor(n.wordTone),
                )
            }
            if (n.opens) {
                Icon(Icons.Outlined.ExpandMore, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(16.dp).rotate(if (selected) 180f else 0f))
            }
        }
    }
    if (n.opens) {
        val hint = stringResource(if (selected) R.string.conn_hide_fix else R.string.conn_show_fix)
        val description = listOfNotNull(n.name ?: stringResource(R.string.conn_tailscale), word).joinToString(", ")
        Box(
            Modifier
                .minimumInteractiveComponentSize()
                .clickable(role = Role.Button, onClickLabel = hint, onClick = onClick)
                .testTag("strip.${n.id}")
                .clearAndSetSemantics { contentDescription = description },
        ) { label() }
    } else {
        val state = stringResource(stateName(n.tone))
        Box(
            Modifier
                .minimumInteractiveComponentSize()
                .testTag("strip.${n.id}")
                .clearAndSetSemantics { contentDescription = "${n.name.orEmpty()}, $state" },
        ) { label() }
    }
}

private fun stateName(tone: Tone): Int = when (tone) {
    Tone.OK -> R.string.conn_state_online
    Tone.WAITING -> R.string.conn_state_connecting
    Tone.OFF -> R.string.conn_state_off
    Tone.WARNING, Tone.DANGER -> R.string.conn_state_online
}

@Composable
private fun wordColor(tone: Tone): Color {
    val p = Nekko.palette
    return when (tone) {
        Tone.WARNING -> p.warning
        Tone.DANGER -> p.danger
        Tone.OK -> p.success
        Tone.WAITING -> p.running
        Tone.OFF -> p.inkFaint
    }
}

/** A filled dot for online and problems, a hollow ring for dialing and for off by choice. */
@Composable
private fun StateDot(tone: Tone) {
    val p = Nekko.palette
    val color = when (tone) {
        Tone.OK -> p.success
        Tone.WAITING -> p.running
        Tone.OFF -> p.inkFaint
        Tone.WARNING -> p.warning
        Tone.DANGER -> p.danger
    }
    val hollow = tone == Tone.WAITING || tone == Tone.OFF
    Box(
        Modifier.size(8.dp).clip(CircleShape).then(if (hollow) Modifier.border(1.5.dp, color, CircleShape) else Modifier.background(color)),
    )
}

@Composable
private fun Detail(n: ConnectionNote, s: ComputersState?, exits: SafetyExits?, onAction: (ConnectionNote, Action) -> Unit) {
    val p = Nekko.palette
    val res = LocalResources.current
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = p.inkSoft)) { append(n.line?.text(res).orEmpty()) }
                val tail = n.tail.joinToString(" ") { it.text(res) }
                if (tail.isNotEmpty()) withStyle(SpanStyle(color = p.inkFaint)) { append(" "); append(tail) }
            },
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("strip.line"),
        )
        val showMenu = n.more && exits != null && s != null
        if (n.actions.isNotEmpty() || showMenu) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                n.actions.forEachIndexed { i, a ->
                    TextButton(
                        onClick = { onAction(n, a) },
                        modifier = Modifier.testTag(actionTag(a)),
                    ) {
                        Text(stringResource(actionLabel(a)), fontWeight = FontWeight.SemiBold, color = if (i == 0) p.accent else p.ink)
                    }
                }
                Box(Modifier.weight(1f))
                if (showMenu) {
                    Box {
                        IconButton(onClick = { menu = true }, modifier = Modifier.testTag("banner.menu")) {
                            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.chats_safety_options, n.name.orEmpty()), tint = p.inkSoft)
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            SafetyExitMenuItems(s!!, exits!!, onPicked = { menu = false })
                        }
                    }
                }
            }
        } else {
            Box(Modifier.size(8.dp))
        }
    }
}

private fun actionLabel(a: Action): Int = when (a) {
    Action.RETRY -> R.string.conn_retry
    Action.TRY_AGAIN -> R.string.conn_try_again
    Action.PAIR_AGAIN -> R.string.chats_pair_again
    Action.OPEN_TAILSCALE -> R.string.conn_open_tailscale
    Action.DETAILS -> R.string.conn_details
}

private fun actionTag(a: Action): String = when (a) {
    Action.RETRY -> "fleet.reconnect"
    Action.TRY_AGAIN -> "banner.try-again"
    Action.PAIR_AGAIN -> "banner.pair-again"
    Action.OPEN_TAILSCALE -> "open-tailscale"
    Action.DETAILS -> "banner.details"
}

/** Android lets an app open another: the Tailscale app if it is installed, else its Play Store page. */
private fun openTailscale(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(TAILSCALE_PACKAGE)
    val intent = launch ?: Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$TAILSCALE_PACKAGE"))
    try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$TAILSCALE_PACKAGE")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
