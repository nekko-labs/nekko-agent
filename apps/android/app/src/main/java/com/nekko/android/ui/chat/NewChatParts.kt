package com.nekko.android.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.data.ComputersRepository
import com.nekko.android.ui.components.PixelCat
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Channels
import com.nekko.protocol.ConnectChecklist
import com.nekko.protocol.LimitLine
import com.nekko.protocol.PhoneRateLimits
import com.nekko.protocol.ProviderLimits
import com.nekko.protocol.providerLimits
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive

/**
 * One quiet line under the model (#2950, the iPhone's `LimitLineView`, #2923): a 3 dp meter and the
 * tightest window's words, faint below 75%, the warning colour from 75%, danger when reached.
 * At the limit, [switchModel] offers another model.
 */
@Composable
fun LimitLineView(line: LimitLine, modifier: Modifier = Modifier, switchModel: (() -> Unit)? = null) {
    val p = Nekko.palette
    val tint = when (line.level) {
        LimitLine.Level.QUIET -> p.inkFaint
        LimitLine.Level.NEAR -> p.warning
        LimitLine.Level.REACHED -> p.danger
    }
    val label = line.window.label
    val main = if (line.level == LimitLine.Level.REACHED) stringResource(R.string.limit_reached, label)
    else stringResource(R.string.limit_used, line.percent, label)
    val context = androidx.compose.ui.platform.LocalContext.current
    val words = line.window.resetAt?.takeIf { it > 0 }?.let { at ->
        stringResource(R.string.limit_resets, main, android.text.format.DateFormat.getTimeFormat(context).format(java.util.Date(at)))
    } ?: main
    Row(
        modifier.heightIn(min = 24.dp).testTag("limitLine"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(28.dp).height(3.dp).clearAndSetSemantics {}.background(p.line, CircleShape)) {
            Box(Modifier.width(28.dp * (line.percent.coerceIn(0, 100) / 100f)).height(3.dp).background(tint, CircleShape))
        }
        Text(
            words,
            style = MaterialTheme.typography.bodySmall,
            color = if (line.level == LimitLine.Level.QUIET) p.inkSoft else tint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (line.level == LimitLine.Level.REACHED && switchModel != null) {
            TextButton(onClick = switchModel, modifier = Modifier.heightIn(min = 48.dp).testTag("limitLine.switchModel")) {
                Text(stringResource(R.string.limit_switch_model), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = p.accent)
            }
        }
    }
}

/**
 * The limit line for one of this phone's providers, from the rate-limit headers of its last answer
 * (kept in memory only). Rechecked every 5 seconds, so a budget past its reset reads as unused.
 */
@Composable
fun PhoneLimitLine(limits: PhoneRateLimits?, modifier: Modifier = Modifier, switchModel: (() -> Unit)? = null) {
    if (limits == null) return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(limits) {
        while (true) {
            now = System.currentTimeMillis()
            delay(5_000)
        }
    }
    LimitLine.tightest(limits.providerLimits(now))?.let { LimitLineView(it, modifier, switchModel) }
}

/**
 * The limit line for a provider on the active computer: `limits:get`, asked again every 30 seconds
 * while it shows and only while the computer is online. Nothing until the computer reports a window.
 */
@Composable
fun ComputerLimitLine(repo: ComputersRepository, providerId: String?, activeId: String?, online: Boolean, modifier: Modifier = Modifier, switchModel: (() -> Unit)? = null) {
    var limits by remember { mutableStateOf<ProviderLimits?>(null) }
    LaunchedEffect(activeId, providerId, online) {
        limits = null
        if (providerId == null || !online) return@LaunchedEffect
        while (true) {
            limits = try {
                ProviderLimits.from(repo.remote().call(Channels.LIMITS_GET, JsonPrimitive(providerId)))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                limits
            }
            delay(30_000)
        }
    }
    val line = LimitLine.tightest(limits)
    AnimatedVisibility(line != null, enter = fadeIn(), exit = fadeOut()) {
        line?.let { LimitLineView(it, modifier, switchModel) }
    }
}

/** "Model ⟶ device" (#2950, the iPhone's `PlaceConnector`): a faint dot and arrow; TalkBack skips it. */
@Composable
fun PlaceConnector() {
    val p = Nekko.palette
    Row(Modifier.padding(horizontal = 2.dp).clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(1.dp)) {
        Box(Modifier.size(3.dp).background(p.inkFaint, CircleShape))
        Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(10.dp))
    }
}

/**
 * The first of [variants] that fits the width at its natural size, else the last one squeezed to
 * the width: Compose's counterpart of SwiftUI's `ViewThatFits`, for the model ⟶ device line.
 * Each variant is first measured with `live = false` (no menus, nothing for TalkBack or tests);
 * only the chosen one is then composed live and placed.
 */
@Composable
fun FirstThatFits(modifier: Modifier = Modifier, variants: List<@Composable (live: Boolean) -> Unit>) {
    SubcomposeLayout(modifier) { constraints ->
        val loose = constraints.copy(minWidth = 0, maxWidth = Constraints.Infinity)
        var index = variants.lastIndex
        for (i in 0 until variants.lastIndex) {
            val probe = subcompose("probe$i") { Box(Modifier.clearAndSetSemantics {}) { variants[i](false) } }.first().measure(loose)
            if (probe.width <= constraints.maxWidth) {
                index = i
                break
            }
        }
        val chosen = subcompose("live$index") { variants[index](true) }.first()
            .measure(if (index == variants.lastIndex) constraints.copy(minWidth = 0) else loose)
        layout(chosen.width, chosen.height) { chosen.place(0, 0) }
    }
}

@Composable
private fun itemTitle(item: ConnectChecklist.Item): String = stringResource(
    when (item) {
        ConnectChecklist.Item.COMPUTER -> R.string.newchat_item_computer
        ConnectChecklist.Item.FOLDER -> R.string.newchat_item_folder
        ConnectChecklist.Item.GIT -> R.string.newchat_item_git
        ConnectChecklist.Item.TASKS -> R.string.newchat_item_tasks
    },
)

@Composable
private fun itemDetail(row: ConnectChecklist.Row): String = stringResource(
    when (row.item) {
        ConnectChecklist.Item.COMPUTER -> R.string.newchat_item_computer_detail
        ConnectChecklist.Item.FOLDER -> if (row.waiting) R.string.newchat_item_folder_waiting else R.string.newchat_item_folder_detail
        ConnectChecklist.Item.GIT -> R.string.newchat_item_git_detail
        ConnectChecklist.Item.TASKS -> R.string.newchat_item_tasks_detail
    },
)

/** The four rows: each opens its setup; a done row ticks and names what got connected. */
@Composable
fun ConnectChecklistRows(rows: List<ConnectChecklist.Row>, open: (ConnectChecklist.Item) -> Unit) {
    val p = Nekko.palette
    Column {
        rows.forEach { row ->
            val title = itemTitle(row.item)
            val detail = row.done ?: itemDetail(row)
            val state = row.done?.let { stringResource(R.string.newchat_done_named, it) } ?: detail
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .clip(RoundedCornerShape(8.dp))
                    // A waiting folder opens pairing, the step it waits on.
                    .clickable(enabled = !row.isDone, role = Role.Button) { open(if (row.waiting) ConnectChecklist.Item.COMPUTER else row.item) }
                    .padding(horizontal = 4.dp, vertical = 6.dp)
                    .clearAndSetSemantics {
                        contentDescription = title
                        stateDescription = state
                    }
                    .testTag("connectChecklist.${row.item.name.lowercase()}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    if (row.isDone) Icons.Outlined.CheckCircle else Icons.Outlined.Circle,
                    contentDescription = null,
                    tint = if (row.isDone) p.success else p.inkFaint,
                    modifier = Modifier.size(20.dp),
                )
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = p.ink)
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (!row.isDone) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/** Over someone's first message: Nekko leads the four rows, with a count and a close. */
@Composable
fun ConnectChecklistGroup(rows: List<ConnectChecklist.Row>, open: (ConnectChecklist.Item) -> Unit, close: () -> Unit) {
    val p = Nekko.palette
    Column(Modifier.fillMaxWidth().testTag("connectChecklist"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PixelCat(Modifier.size(24.dp).clearAndSetSemantics {})
            Text(
                stringResource(R.string.newchat_checklist_title),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = p.ink,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            Text(stringResource(R.string.newchat_checklist_count, rows.count { it.isDone }, rows.size), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            CloseGlyph(stringResource(R.string.newchat_checklist_close), close, Modifier.testTag("connectChecklist.close"))
        }
        ConnectChecklistRows(rows, open)
    }
}

/** After the first message, while nothing is connected: one closeable line. */
@Composable
fun ConnectNote(connect: () -> Unit, close: () -> Unit) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().testTag("connectNote"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Outlined.Info, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
        Text(stringResource(R.string.newchat_note), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.weight(1f, fill = false))
        TextButton(onClick = connect, modifier = Modifier.heightIn(min = 48.dp).testTag("connectNote.connect")) {
            Text(stringResource(R.string.newchat_connect), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = p.accent)
        }
        Spacer(Modifier.weight(1f, fill = true))
        CloseGlyph(stringResource(R.string.newchat_close), close, Modifier.testTag("connectNote.close"))
    }
}

/** Undo for a closed checklist or note, for a few seconds where it was. */
@Composable
fun ConnectUndoLine(undo: () -> Unit) {
    val p = Nekko.palette
    Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.newchat_checklist_hidden), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        TextButton(onClick = undo, modifier = Modifier.testTag("connectChecklist.undo")) {
            Text(stringResource(R.string.newchat_undo), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = p.accent)
        }
    }
}

/** The note's Connect: the same rows in a sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectChecklistSheet(rows: List<ConnectChecklist.Row>, open: (ConnectChecklist.Item) -> Unit, onDismiss: () -> Unit) {
    val p = Nekko.palette
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).testTag("connectChecklist.sheet"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.newchat_connect), style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.semantics { heading() })
            Text(stringResource(R.string.newchat_checklist_title), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
            ConnectChecklistRows(rows) { item ->
                onDismiss()
                open(item)
            }
        }
    }
}

/** A quiet × with a full touch target. */
@Composable
private fun CloseGlyph(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    IconButton(onClick = onClick, modifier = modifier) {
        Icon(Icons.Outlined.Close, contentDescription = label, tint = Nekko.palette.inkSoft, modifier = Modifier.size(16.dp))
    }
}
