package com.nekko.android.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.StartOffset
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FrontHand
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Activity
import com.nekko.protocol.AgentRows
import com.nekko.protocol.AgentWatch
import com.nekko.protocol.Block
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.ToolStatus
import com.nekko.protocol.Transcript
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

/*
 * The rows for what the agent is doing, drawn as the desktop and the iPhone
 * draw them: no fill, no stroke, one line each with a mark in a fixed box on
 * the left, a label, and a quiet chip on the right; a tool's output opens
 * underneath. Only the user's bubble, the code well and an approval or
 * question card keep an edge in a chat.
 */

/** What the agent rows read beyond a block: the chat's watches, its subagent chats, its model. */
data class AgentContext(
    val watches: List<AgentWatch> = emptyList(),
    val children: List<SessionSummary> = emptyList(),
    val activity: Map<String, Activity> = emptyMap(),
    val running: Boolean = false,
    val modelId: String? = null,
)

/** Null outside a chat (previews, fixtures): the subagent rows then fall back to plain tool rows. */
val LocalAgentContext = compositionLocalOf<AgentContext?> { null }

private val MARK = 16.dp
private val ROW = 36.dp

/** The desktop's running dots: three dots in a fixed box, so the text beside them never moves. */
@Composable
fun RunningDots(color: Color = Nekko.palette.running) {
    val t = rememberInfiniteTransition(label = "dots")
    Row(Modifier.size(MARK).clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val a by t.animateFloat(
                0.25f, 1f,
                infiniteRepeatable(tween(600), RepeatMode.Reverse, StartOffset(i * 200)),
                label = "dot$i",
            )
            Box(Modifier.size(3.5.dp).alpha(a).clip(CircleShape).background(color))
        }
    }
}

/** A small chip with a 1 dp line and no fill (the desktop's one chip rule); quiet ones have no line. */
@Composable
fun RowChip(text: String, modifier: Modifier = Modifier, tone: AgentRows.Tone = AgentRows.Tone.NORMAL, accent: Boolean = false) {
    val p = Nekko.palette
    val color = when {
        accent -> p.accent
        tone == AgentRows.Tone.WARN -> p.warning
        tone == AgentRows.Tone.DANGER -> p.danger
        else -> p.inkFaint
    }
    val quiet = tone == AgentRows.Tone.QUIET
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        maxLines = 1,
        modifier = modifier
            .then(if (quiet) Modifier else Modifier.border(1.dp, color.copy(alpha = 0.7f), RoundedCornerShape(4.dp)))
            .padding(horizontal = if (quiet) 0.dp else 6.dp, vertical = 1.dp),
    )
}

/** An icon in the 16 dp mark box. */
@Composable
private fun Mark(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color) {
    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(MARK))
}

/** The status mark of a step, in the same box as the dots. */
@Composable
fun StepMark(status: ToolStatus) {
    val p = Nekko.palette
    when (status) {
        ToolStatus.RUNNING -> RunningDots()
        ToolStatus.WAITING -> Mark(Icons.Filled.FrontHand, p.warning)
        ToolStatus.OK -> Mark(Icons.Filled.Check, p.success)
        ToolStatus.ERROR -> Mark(Icons.Filled.Close, p.danger)
    }
}

fun statusName(s: ToolStatus) = when (s) {
    ToolStatus.RUNNING -> "running"
    ToolStatus.WAITING -> "waiting for you"
    ToolStatus.OK -> "done"
    ToolStatus.ERROR -> "failed"
}

/** A tool's output as a code well under its row, with the phone's notes under it. */
@Composable
fun OutputWell(output: String, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    // What the phone doesn't show (cut output, left-out images) goes under the 40 lines.
    val (body, notes) = Transcript.splitNotes(output)
    Column(modifier.padding(start = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SelectionContainer {
            Text(
                body.ifEmpty { "(no output)" },
                style = Nekko.mono,
                color = p.ink,
                maxLines = 40,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.code).padding(10.dp),
            )
        }
        if (notes.isNotEmpty()) Text(notes.joinToString("\n"), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}

/** The one-line head every agent row shares: a mark, the text, then trailing chips; taps open what's under it. */
@Composable
private fun RowHead(
    onClick: (() -> Unit)?,
    description: String,
    state: String? = null,
    mark: @Composable () -> Unit,
    trailing: @Composable () -> Unit = {},
    text: @Composable (Modifier) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .heightIn(min = ROW)
            .semantics(mergeDescendants = true) {
                contentDescription = description
                if (state != null) stateDescription = state
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        mark()
        text(Modifier.weight(1f))
        trailing()
    }
}

@Composable
private fun Chevron(open: Boolean) {
    Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, contentDescription = null, tint = Nekko.palette.inkFaint, modifier = Modifier.size(18.dp))
}

/** One tool call: its mark, its label and, when it has output, a chevron that opens the code well. */
@Composable
fun ToolRow(b: Block.Tool) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val hasOutput = !b.output.isNullOrEmpty()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        RowHead(
            onClick = if (hasOutput) ({ open = !open }) else null,
            description = "${b.label}, ${statusName(b.status)}",
            state = if (!hasOutput) null else if (open) "Output shown" else "Output hidden",
            mark = { StepMark(b.status) },
            trailing = { if (hasOutput) Chevron(open) },
        ) { m ->
            Text(b.label, style = Nekko.mono, color = p.inkSoft, maxLines = if (open) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis, modifier = m)
        }
        if (open && hasOutput) OutputWell(b.output.orEmpty())
    }
}

/** The subline under a watch: what the agent does when it wakes. */
@Composable
private fun ThenLine(text: String) {
    val p = Nekko.palette
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = p.inkSoft)) { append("then") }
            withStyle(SpanStyle(color = p.inkFaint)) { append(" · $text") }
        },
        style = MaterialTheme.typography.bodySmall,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(start = 24.dp),
    )
}

/** Now, once a second while [ticking] (and on screen), else once. */
@Composable
private fun rememberNow(ticking: Boolean): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ticking) {
        while (ticking) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** The watch's timer chip: ticks once a second while it is counting. */
@Composable
private fun WatchClockChip(call: AgentRows.WatchCall, view: AgentWatch?) {
    val context = LocalContext.current
    val fmt = remember(context) { android.text.format.DateFormat.getTimeFormat(context) }
    val time: (Long) -> String = { fmt.format(Date(it)) }
    val ticking = AgentRows.watchClock(call, view, System.currentTimeMillis(), time)?.ticking == true
    val clock = AgentRows.watchClock(call, view, rememberNow(ticking), time) ?: return
    RowChip(clock.text, Modifier.semantics { contentDescription = clock.detail }, clock.tone)
}

/**
 * An armed watch: what it watches and what fires it, a *then ·* line, and a
 * live chip from the computer's `session:watches`.
 */
@Composable
fun WatchRow(b: Block.Tool, watches: List<AgentWatch>) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val failed = b.status == ToolStatus.ERROR
    val call = AgentRows.parseWatch(b.input, b.output, failed)
    val view = call.id?.let { id -> watches.firstOrNull { it.id == id } }
    val then = AgentRows.thenSummary(call.prompt)
    val headline = AgentRows.watchHeadline(call, if (failed) b.output else null)
    val hasOutput = b.output != null
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        RowHead(
            onClick = if (hasOutput) ({ open = !open }) else null,
            description = headline,
            mark = { if (b.status == ToolStatus.RUNNING) RunningDots() else Mark(Icons.Outlined.Visibility, if (failed) p.danger else p.accent) },
            trailing = { if (call.action == AgentRows.WatchCall.Action.CREATE && !failed) WatchClockChip(call, view) },
        ) { m ->
            Text(headline, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = m)
        }
        if (then.isNotEmpty() && call.action == AgentRows.WatchCall.Action.CREATE) ThenLine(then)
        if (open && hasOutput) OutputWell(b.output.orEmpty())
    }
}

/** The wake-up the computer sent when a watch fired: a step of the run, not a bubble from the user; opens to the whole text. */
@Composable
fun WatchWakeRow(wake: AgentRows.Wake, content: String, at: Long?) {
    val p = Nekko.palette
    var open by rememberSaveable(content) { mutableStateOf(false) }
    val then = AgentRows.thenSummary(wake.prompt)
    val detail = if (wake.detail.isEmpty()) "" else " (${wake.detail})"
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        RowHead(
            onClick = { open = !open },
            description = "Watch triggered, ${wake.trigger}. ${wake.detail}",
            state = if (open) "Wake-up text shown" else "Wake-up text hidden",
            mark = { Mark(Icons.Filled.Bolt, p.accent) },
            trailing = {
                if (at != null && at > 0) {
                    Text(DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at)), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
                }
            },
        ) { m ->
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append("Watch triggered") }
                    append(" · ${wake.trigger}$detail")
                },
                style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = m,
            )
        }
        if (then.isNotEmpty()) ThenLine(then)
        if (open) {
            SelectionContainer {
                Text(content, style = Nekko.mono, color = p.inkFaint, maxLines = 24, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 24.dp))
            }
        }
    }
}

private fun subagentState(b: Block.Tool, ctx: AgentContext): AgentRows.SubagentStatus {
    val child = AgentRows.subagentChild(b.input, ctx.children)
    return AgentRows.subagentStatus(b.output, b.status == ToolStatus.ERROR, child?.let { ctx.activity[it.id] }, ctx.running)
}

/** One delegation's child: its mark, its title and what it is doing, its model as a quiet chip. */
@Composable
fun SubagentRow(b: Block.Tool, ctx: AgentContext) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val state = subagentState(b, ctx)
    val child = AgentRows.subagentChild(b.input, ctx.children)
    val model = AgentRows.subagentModel(b.input, child, ctx.children, ctx.modelId)
    val title = AgentRows.subagentTitle(b.input)
    val detail = when (state) {
        AgentRows.SubagentStatus.WORKING -> "working"
        AgentRows.SubagentStatus.WAITING -> if (b.output == null) "waiting" else "waiting for you"
        AgentRows.SubagentStatus.COMPLETED -> "done"
        AgentRows.SubagentStatus.FAILED -> "failed"
        AgentRows.SubagentStatus.STOPPED -> "stopped"
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        RowHead(
            onClick = { open = !open },
            description = "Subagent $title, $detail",
            state = if (open) "Task shown" else "Task hidden",
            mark = {
                when (state) {
                    AgentRows.SubagentStatus.WORKING -> RunningDots()
                    AgentRows.SubagentStatus.WAITING -> Mark(Icons.Filled.FrontHand, p.warning)
                    AgentRows.SubagentStatus.COMPLETED -> Mark(Icons.Filled.Check, p.success)
                    AgentRows.SubagentStatus.FAILED -> Mark(Icons.Filled.Close, p.danger)
                    AgentRows.SubagentStatus.STOPPED -> Mark(Icons.Filled.Pause, p.inkFaint)
                }
            },
            trailing = { model?.let { RowChip(AgentRows.shortModelName(it.first), tone = AgentRows.Tone.QUIET) } },
        ) { m ->
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = p.ink, fontWeight = FontWeight.SemiBold)) { append(title) }
                    withStyle(SpanStyle(color = p.inkSoft)) { append(" · $detail") }
                },
                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = m,
            )
        }
        if (open) {
            val task = AgentRows.subagentTask(b.input)
            if (task.isNotEmpty()) {
                SelectionContainer { Text(task, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(start = 24.dp)) }
            }
            b.output?.let { OutputWell(it) }
        }
    }
}

/** Children indented on a hairline, as the desktop's step list. */
@Composable
fun Hairline(content: @Composable () -> Unit) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(24.dp).fillMaxHeight()) {
            Box(Modifier.padding(start = 7.dp, top = 4.dp, bottom = 4.dp).width(1.5.dp).fillMaxHeight().background(p.line))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
    }
}

/** A run of delegations: a header with the count and the parent's model, then each child on a hairline. */
@Composable
fun SubagentGroup(blocks: List<Block.Tool>, ctx: AgentContext) {
    val p = Nekko.palette
    val states = blocks.map { subagentState(it, ctx) }
    val working = states.count { it == AgentRows.SubagentStatus.WORKING }
    val waiting = states.count { it == AgentRows.SubagentStatus.WAITING }
    val n = if (blocks.size == 1) "1 subagent" else "${blocks.size} subagents"
    val headline = when {
        working > 0 -> "$n · $working working"
        waiting > 0 -> "$n · $waiting waiting"
        else -> "$n · done"
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        RowHead(
            onClick = null,
            description = headline + (ctx.modelId?.let { ", model $it" } ?: ""),
            mark = { if (working > 0) RunningDots() else Mark(Icons.Outlined.AccountTree, p.accent) },
            trailing = { ctx.modelId?.let { RowChip(AgentRows.shortModelName(it), accent = true) } },
        ) { m ->
            Text(headline, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = m)
        }
        Hairline { blocks.forEach { SubagentRow(it, ctx) } }
    }
}

/** A delegation drawn alone or in a group needs the chat; without it (previews) it is a plain tool row. */
@Composable
fun AgentToolRow(b: Block.Tool) {
    val ctx = LocalAgentContext.current
    when {
        b.name == AgentRows.WATCH_TOOL -> WatchRow(b, ctx?.watches.orEmpty())
        b.name == AgentRows.SUBAGENT_TOOL && ctx != null -> SubagentRow(b, ctx)
        else -> ToolRow(b)
    }
}

/** Whether a run of blocks is all delegations, to be drawn as [SubagentGroup]. */
fun allSubagents(blocks: List<Block>): Boolean = blocks.isNotEmpty() && blocks.all { it is Block.Tool && it.name == AgentRows.SUBAGENT_TOOL }
