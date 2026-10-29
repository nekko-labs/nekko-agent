package com.nekko.android.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.RichTooltip
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.setProgress
import com.nekko.android.ui.simple.rememberReduceMotion
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.ViewInAr
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nekko.android.R
import com.nekko.android.chat.ChatUi
import com.nekko.android.data.ComputersState
import com.nekko.android.data.ModelPick
import com.nekko.android.data.modelGroups
import com.nekko.android.monitors.HardwareState
import com.nekko.android.ui.screens.ModelList
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ContextUsage
import com.nekko.protocol.Effort
import com.nekko.protocol.EngineStatus
import com.nekko.protocol.MonitorFormat
import com.nekko.protocol.MonitorTone
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Test tags the instrumented tests find the controls by. */
object ModeTags {
    const val MODEL_EFFORT = "chat.modelEffort"
    const val CONTEXT = "chat.context"
    const val LONG_CHAT = "chat.longChat"
    const val MONITOR = "chat.monitor"
    const val MONITOR_SHEET = "monitor.sheet"
    fun effort(e: Effort) = "modelEffort.${e.wire}"
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** A gauge's arc: [fraction] of a 240° sweep, open at the bottom. */
private fun DrawScope.gaugeArc(fraction: Float, color: Color, width: Float) {
    val inset = width / 2
    drawArc(
        color, startAngle = 150f, sweepAngle = 240f * fraction.coerceIn(0f, 1f), useCenter = false,
        topLeft = Offset(inset, inset), size = Size(size.width - width, size.height - width),
        style = Stroke(width, cap = StrokeCap.Round),
    )
}

@Composable
private fun toneColor(t: MonitorTone): Color = when (t) {
    MonitorTone.OK -> Nekko.palette.accent
    MonitorTone.WARN -> Nekko.palette.warning
    MonitorTone.HOT -> Nekko.palette.danger
}

/**
 * How hard the model works, as a dial: one notch per level the model takes. No
 * level (the computer's own setting) leaves the arc empty and the needle centred.
 */
@Composable
fun EffortDial(level: Int?, count: Int, size: Dp = 24.dp) {
    val p = Nekko.palette
    val target = level?.let { (it + 1f) / count.coerceAtLeast(1) }
    val needle by animateFloatAsState(target ?: 0.5f, label = "effort-needle")
    val ink = if (target == null) p.inkFaint else p.ink
    Canvas(Modifier.size(size)) {
        val w = (this.size.minDimension * 0.12f).coerceAtLeast(2.dp.toPx())
        gaugeArc(1f, p.surface2, w)
        if (target != null) gaugeArc(target, p.accent, w)
        val c = center
        val r = this.size.minDimension / 2 * 0.72f
        val a = Math.toRadians(150.0 + 240.0 * needle)
        drawLine(ink, c, Offset(c.x + r * cos(a).toFloat(), c.y + r * sin(a).toFloat()), (this.size.minDimension * 0.07f).coerceAtLeast(1.5.dp.toPx()), StrokeCap.Round)
        drawCircle(ink, this.size.minDimension * 0.08f, c)
    }
}

/** One reading as a dial: the arc fills with the load, the value in the middle, a caption (a temperature) under it. */
@Composable
fun RingDial(fraction: Double?, value: String, label: String, caption: String? = null, captionTone: MonitorTone = MonitorTone.OK, size: Dp = 64.dp) {
    val p = Nekko.palette
    val fill by animateFloatAsState((fraction ?: 0.0).toFloat(), label = "ring")
    val tone = toneColor(MonitorTone.of(fraction))
    val px = size.value
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.semantics(mergeDescendants = true) {
            contentDescription = label
            stateDescription = caption?.let { "$value, $it" } ?: value
        },
    ) {
        Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(size)) {
                val w = this.size.minDimension * 0.1f
                gaugeArc(1f, p.surface2, w)
                if (fraction != null) gaugeArc(fill, tone, w)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(value, fontSize = (px * 0.22f).sp, fontWeight = FontWeight.SemiBold, color = if (fraction == null) p.inkFaint else p.ink, maxLines = 1)
                caption?.let {
                    Text(it, fontSize = (px * 0.16f).sp, color = if (captionTone == MonitorTone.OK) p.inkSoft else toneColor(captionTone), maxLines = 1)
                }
            }
        }
        Text(label, style = MaterialTheme.typography.labelSmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = size + 24.dp))
    }
}

@Composable
fun effortLabel(e: Effort): String = stringResource(
    when (e) {
        Effort.LOW -> R.string.effort_low
        Effort.MEDIUM -> R.string.effort_medium
        Effort.NORMAL -> R.string.effort_normal
        Effort.HIGH -> R.string.effort_high
        Effort.XHIGH -> R.string.effort_xhigh
        Effort.MAX -> R.string.effort_max
    },
)

// ---------------------------------------------------------------------------
// Model, effort and context: the row under the message box
// ---------------------------------------------------------------------------

/** Which halves of the model and effort control show: a chat with no model yet still offers the picker, whatever Simple hides. */
@Composable
private fun modelEffortShown(chat: ChatUi): Pair<Boolean, Boolean> {
    val simple = LocalSimple.current
    return (simple.shown("model") || chat.modelId == null) to simple.shown("effort")
}

/** Under the message box: the model and effort control on the left, the context ring on the right, each as Simple allows. */
@Composable
fun ChatOptionsRow(chat: ChatUi, enabled: Boolean, onOpenModelEffort: () -> Unit, modifier: Modifier = Modifier) {
    val (model, effort) = modelEffortShown(chat)
    val context = LocalSimple.current.shown("context")
    if (!model && !effort && !context) return
    Row(
        modifier.fillMaxWidth().background(Nekko.palette.paper).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (model || effort) ModelEffortButton(chat, enabled, onOpenModelEffort, model, effort)
        Spacer(Modifier.weight(1f))
        if (context) ContextRing(chat)
    }
}

/**
 * Simple's slim line above the message box once the chat fills most of its window: how many
 * tokens starting fresh saves, Start fresh (a new chat on the same model), and dismiss.
 */
@Composable
fun LongChatNudge(tokens: Long, onStartFresh: (() -> Unit)?, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Row(
        modifier.fillMaxWidth().background(p.surface).padding(start = 16.dp, end = 4.dp).heightIn(min = 40.dp).testTag(ModeTags.LONG_CHAT),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "This chat is getting long. Starting fresh saves about ${MonitorFormat.tokens(tokens)} tokens.",
            style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.weight(1f).padding(vertical = 6.dp),
        )
        if (onStartFresh != null) TextButton(onClick = onStartFresh) { Text("Start fresh", color = p.accent) }
        IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = "Dismiss", tint = p.inkFaint, modifier = Modifier.size(16.dp)) }
    }
}

/** An effort dial and the model's name (either can be hidden by Simple); opens the model and effort sheet. */
@Composable
private fun ModelEffortButton(chat: ChatUi, enabled: Boolean, onClick: () -> Unit, showModel: Boolean, showEffort: Boolean) {
    val p = Nekko.palette
    val levels = Effort.levels(chat.modelId)
    val level = chat.effort?.let { levels.indexOf(it) }?.takeIf { it >= 0 }
    val name = chat.modelName ?: stringResource(R.string.model_choose)
    val label = stringResource(if (!showEffort) R.string.model_section else if (!showModel) R.string.effort_section else R.string.model_effort)
    val effort = chat.effort?.let { effortLabel(it) } ?: stringResource(R.string.effort_computer_default)
    Row(
        Modifier
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(start = 4.dp, end = 8.dp)
            .testTag(ModeTags.MODEL_EFFORT)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                stateDescription = listOfNotNull(name.takeIf { showModel }, effort.takeIf { showEffort }).joinToString(", ")
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (showEffort) EffortDial(level, levels.size, 18.dp)
        if (showModel) Text(name, style = MaterialTheme.typography.labelLarge, color = if (enabled) p.ink else p.inkFaint, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.widthIn(max = 220.dp))
        Icon(Icons.Filled.UnfoldMore, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
    }
}

/** The chat's model, and its effort on a large dial with one stop per level. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ModelEffortSheet(
    chat: ChatUi,
    computers: ComputersState,
    onSet: suspend (providerId: String?, modelId: String?, effort: Effort?) -> Unit,
    onLoadModels: suspend () -> Unit,
    onDismiss: () -> Unit,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var picking by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<Effort?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val levels = Effort.levels(chat.modelId)
    val level = chat.effort?.let { levels.indexOf(it) }?.takeIf { it >= 0 }
    val computer = computers.active?.name ?: stringResource(R.string.your_computer)
    val (showModel, showEffort) = modelEffortShown(chat)
    fun run(effort: Effort?, pick: ModelPick?) {
        error = null
        busy = effort
        scope.launch {
            try {
                onSet(pick?.providerId, pick?.modelId, effort)
                if (pick != null) picking = false
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn’t change it."
            } finally {
                busy = null
            }
        }
    }
    LaunchedEffect(picking) { if (picking) runCatching { onLoadModels() } }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(if (!showEffort) R.string.model_section else if (!showModel) R.string.effort_section else R.string.model_effort), style = MaterialTheme.typography.titleMedium, color = p.ink)
            if (showModel) {
                SectionTitle(stringResource(R.string.model_section))
                Row(
                    Modifier.fillMaxWidth().clip16().background(p.surface).clickable(role = Role.Button) { picking = !picking }.heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(chat.modelName ?: stringResource(R.string.model_choose), style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        chat.modelId?.takeIf { it != chat.modelName }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint)
                }
                if (picking) {
                    ModelList(
                        groups = modelGroups(computers),
                        favorites = computers.defaults.favoriteModels,
                        query = query,
                        onQuery = { query = it },
                        selected = chat.providerId?.let { pr -> chat.modelId?.let { ModelPick(pr, it) } },
                        onPick = { run(null, it) },
                        onRetry = { scope.launch { runCatching { onLoadModels() } } },
                    )
                }
            }
            if (showEffort) {
                EffortSlider(levels, level, busy, onPick = { run(it, null) })
                Text(
                    if (chat.effort == null) stringResource(R.string.effort_following, computer) else stringResource(R.string.effort_footer),
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkSoft,
                )
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
        }
    }
}

/**
 * The stop of [count] evenly spaced stops on a track from [start] to [end] nearest a touch at [x].
 * A touch past either end snaps to that end.
 */
internal fun effortStop(x: Float, start: Float, end: Float, count: Int): Int {
    if (count <= 1 || end <= start) return 0
    return Math.round((x - start) / (end - start) * (count - 1)).coerceIn(0, count - 1)
}

/**
 * Effort as a short track that snaps to the model's levels, their names under it and the current
 * one's name over it. The filled part is a gradient that deepens toward the thumb, deeper for higher
 * levels, with light streaks drifting through it (faster for higher levels, still when motion is off).
 * No level (the computer's own setting) leaves the track empty and the thumb faint in the middle.
 */
@Composable
private fun EffortSlider(levels: List<Effort>, level: Int?, busy: Effort?, onPick: (Effort) -> Unit) {
    val p = Nekko.palette
    val n = levels.size
    var dragging by remember { mutableStateOf<Int?>(null) }
    val shown = dragging ?: level
    val enabled = busy == null
    val still = rememberReduceMotion()
    val pick: (Int) -> Unit = { i -> if (enabled && i != level) onPick(levels[i]) }
    val name = shown?.let { effortLabel(levels[it]) } ?: stringResource(R.string.effort_computer_default)
    val sectionLabel = stringResource(R.string.effort_section)
    // How intense the fill is: 0 at the lowest level, 1 at the highest.
    val intensity = shown?.let { if (n > 1) it.toFloat() / (n - 1) else 1f }
    val phase = if (still || intensity == null) 0.35f else {
        val speed = (1600 - 1000 * intensity).toInt()
        val t by rememberInfiniteTransition(label = "effort-streaks").animateFloat(
            0f, 1f, infiniteRepeatable(tween(speed, easing = LinearEasing)), label = "effort-phase",
        )
        t
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionTitle(sectionLabel)
            Spacer(Modifier.weight(1f))
            if (busy != null) CircularProgressIndicator(strokeWidth = 2.dp, color = p.accent, modifier = Modifier.padding(end = 6.dp).size(14.dp))
            Text(name, style = MaterialTheme.typography.titleSmall, color = if (shown == null) p.inkSoft else p.ink)
        }
        // The track's ends sit over the first and last names' centres, so each stop is over its name.
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(36.dp)
                .pointerInput(levels, enabled) {
                    if (!enabled) return@pointerInput
                    val inset = size.width / (2f * n)
                    detectTapGestures { pick(effortStop(it.x, inset, size.width - inset, n)) }
                }
                .pointerInput(levels, enabled) {
                    if (!enabled) return@pointerInput
                    val inset = size.width / (2f * n)
                    detectHorizontalDragGestures(
                        onDragStart = { dragging = effortStop(it.x, inset, size.width - inset, n) },
                        onDragEnd = { dragging?.let(pick); dragging = null },
                        onDragCancel = { dragging = null },
                    ) { change, _ -> dragging = effortStop(change.position.x, inset, size.width - inset, n) }
                }
                .semantics {
                    contentDescription = sectionLabel
                    stateDescription = name
                    progressBarRangeInfo = ProgressBarRangeInfo((level ?: 0).toFloat(), 0f..(n - 1).coerceAtLeast(1).toFloat(), steps = (n - 2).coerceAtLeast(0))
                    if (enabled) setProgress { v -> pick(Math.round(v).coerceIn(0, n - 1)); true }
                },
        ) {
            val inset = size.width / (2f * n)
            val trackH = 8.dp.toPx()
            val top = (size.height - trackH) / 2
            val radius = CornerRadius(trackH / 2)
            val x = { i: Int -> if (n > 1) inset + i * (size.width - 2 * inset) / (n - 1) else size.width / 2 }
            drawRoundRect(p.surface2, Offset(inset - trackH / 2, top), Size(size.width - 2 * inset + trackH, trackH), radius)
            if (shown == null || intensity == null) {
                for (i in 0 until n) drawCircle(p.line, 2.dp.toPx(), Offset(x(i), size.height / 2))
                drawCircle(p.inkFaint.copy(alpha = 0.45f), 9.dp.toPx(), Offset(size.width / 2, size.height / 2))
                return@Canvas
            }
            val thumb = x(shown)
            val strong = p.accent.copy(alpha = 0.45f + 0.55f * intensity)
            val left = inset - trackH / 2
            val fillW = thumb - left
            drawRoundRect(
                Brush.horizontalGradient(listOf(p.accent.copy(alpha = 0.15f), strong), startX = left, endX = thumb),
                Offset(left, top), Size(fillW, trackH), radius,
            )
            // Speed lines: short light streaks drifting left to right inside the filled part.
            clipRect(left, top, thumb, top + trackH) {
                val streak = 7.dp.toPx()
                for (k in 0 until 5) {
                    val at = (phase + k * 0.21f) % 1f
                    val sx = left + at * (fillW + streak) - streak
                    val sy = top + trackH * (0.25f + 0.5f * ((k * 0.37f) % 1f))
                    drawLine(Color.White.copy(alpha = 0.55f), Offset(sx, sy), Offset(sx + streak * (0.6f + 0.4f * (k % 2)), sy), 1.dp.toPx(), StrokeCap.Round)
                }
            }
            for (i in shown + 1 until n) drawCircle(p.line, 2.dp.toPx(), Offset(x(i), size.height / 2))
            drawCircle(strong.copy(alpha = 1f), 9.dp.toPx(), Offset(thumb, size.height / 2))
            drawCircle(p.paper, 3.5.dp.toPx(), Offset(thumb, size.height / 2))
        }
        Row(Modifier.fillMaxWidth().selectableGroup()) {
            levels.forEachIndexed { i, e ->
                val on = i == level
                Box(
                    Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .selectable(on, enabled = enabled, role = Role.RadioButton) { pick(i) }
                        .testTag(ModeTags.effort(e)),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Text(
                        effortLabel(e), style = MaterialTheme.typography.labelSmall, color = if (i == shown) p.ink else p.inkSoft,
                        fontWeight = if (i == shown) FontWeight.SemiBold else null, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint)

private fun Modifier.clip16() = clip(RoundedCornerShape(16.dp))

/** The chat's context window: a ring that fills as the window does and the count. Tap for what fills it. */
@Composable
private fun ContextRing(chat: ChatUi) {
    val p = Nekko.palette
    var open by remember { mutableStateOf(false) }
    val used = chat.contextTokens
    val window = chat.context?.contextWindow
    val fraction = used?.let { u -> window?.let { (u.toDouble() / it.coerceAtLeast(1)).coerceAtMost(1.0) } }
    val tone = ContextUsage(used ?: 0, window).tone
    val fill by animateFloatAsState((fraction ?: 0.0).toFloat(), label = "context")
    val color = toneColor(tone)
    val label = stringResource(R.string.context_window)
    val description = contextDescription(used, window)
    Box {
        Row(
            Modifier
                .heightIn(min = 48.dp)
                .clickable(enabled = chat.context != null, role = Role.Button) { open = true }
                .padding(horizontal = 8.dp)
                .testTag(ModeTags.CONTEXT)
                .semantics(mergeDescendants = true) {
                    contentDescription = label
                    stateDescription = description
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Canvas(Modifier.size(16.dp)) {
                val w = 3.dp.toPx()
                val inset = w / 2
                val arc = Size(size.width - w, size.height - w)
                drawArc(p.surface2, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(w))
                if (fraction != null) drawArc(color, -90f, 360f * fill, false, Offset(inset, inset), arc, style = Stroke(w, cap = StrokeCap.Round))
            }
            Text(MonitorFormat.context(used, window), style = MaterialTheme.typography.labelMedium, color = if (tone == MonitorTone.OK) p.inkSoft else color)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            ContextBreakdown(chat, Modifier.widthIn(min = 260.dp).padding(horizontal = 16.dp, vertical = 8.dp))
        }
    }
}

@Composable
private fun contextDescription(used: Long?, window: Long?): String = when {
    used == null -> stringResource(R.string.context_unknown)
    window == null -> stringResource(R.string.context_tokens, MonitorFormat.tokens(used))
    else -> stringResource(R.string.context_tokens_of, MonitorFormat.tokens(used), MonitorFormat.tokens(window))
}

@Composable
private fun contextSourceName(s: String): String = when (s) {
    "system" -> stringResource(R.string.context_system)
    "conversation" -> stringResource(R.string.context_conversation)
    "attached-file" -> stringResource(R.string.context_attached)
    "guideline" -> stringResource(R.string.context_guideline)
    "memory" -> stringResource(R.string.context_memory)
    "connector" -> stringResource(R.string.context_connector)
    "index-snippet" -> stringResource(R.string.context_index)
    "skill" -> stringResource(R.string.context_skill)
    else -> s
}

/** Where the chat's tokens go, biggest first, and what is left. */
@Composable
fun ContextBreakdown(chat: ChatUi, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.context_window), style = MaterialTheme.typography.titleSmall, color = p.ink)
        val c = chat.context
        if (c == null) {
            Text(stringResource(R.string.context_unknown), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            return@Column
        }
        val used = chat.contextTokens ?: c.usedTokens
        Text(contextDescription(used, c.contextWindow), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        c.sources.forEach { (source, tokens) ->
            val share = c.contextWindow?.let { "${Math.round(tokens.toDouble() / it * 100)}%" }
            BreakdownRow(contextSourceName(source), MonitorFormat.tokens(tokens), share)
        }
        if (used > c.usedTokens) BreakdownRow(stringResource(R.string.context_reply), MonitorFormat.tokens(used - c.usedTokens), null)
        c.contextWindow?.let { w ->
            HorizontalDivider(color = p.line)
            BreakdownRow(stringResource(R.string.context_free), MonitorFormat.tokens((w - used).coerceAtLeast(0)), null, bold = true)
        }
    }
}

@Composable
private fun BreakdownRow(name: String, value: String, share: String?, bold: Boolean = false) {
    val p = Nekko.palette
    val style = if (bold) MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold) else MaterialTheme.typography.bodySmall
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = style, color = p.ink, modifier = Modifier.weight(1f))
        Text(value, style = style, color = p.inkSoft)
        if (share != null) Text(share, style = style, color = p.inkFaint, modifier = Modifier.widthIn(min = 40.dp).padding(start = 8.dp))
    }
}

// ---------------------------------------------------------------------------
// Expert monitor
// ---------------------------------------------------------------------------

/** One hardware reading in the desktop Hardware monitor's order: CPU, memory, each GPU, then GPU memory. */
data class HardwareRow(val label: String, val fraction: Double?, val value: String, val temp: Double?, val detail: String? = null)

@Composable
fun hardwareRows(s: HardwareState): List<HardwareRow> {
    val cpu = s.system?.let { (it.cpuPct / 100).coerceIn(0.0, 1.0) }
    val memory = s.system?.takeIf { it.memTotalMB > 0 }?.let { MonitorFormat.memory(it.memUsedMB, it.memTotalMB) }
    val rows = mutableListOf(
        HardwareRow(stringResource(R.string.hw_cpu), cpu, MonitorFormat.percent(cpu), s.system?.cpuC, s.system?.cpuCores?.takeIf { it > 0 }?.let { stringResource(R.string.hw_cores, it) }),
        HardwareRow(stringResource(R.string.hw_memory), s.system?.memFraction, MonitorFormat.percent(s.system?.memFraction), s.system?.memoryC, memory),
    )
    val gpuMemory = s.gpu?.takeIf { it.totalMB > 0 }?.let { g -> stringResource(if (g.unified) R.string.hw_gpu_memory else R.string.hw_vram) to MonitorFormat.memory(g.usedMB, g.totalMB) }
    val devices = s.gpu?.devices.orEmpty()
    devices.forEach { d ->
        val f = d.utilizationPct?.let { (it / 100).coerceIn(0.0, 1.0) }
        val name = if (devices.size == 1) stringResource(R.string.hw_gpu) else stringResource(R.string.hw_gpu_n, d.index + 1)
        // The board's sensor fills in for the only GPU, as on the desktop.
        val temp = d.temperatureC ?: s.system?.gpuC?.takeIf { devices.size == 1 }
        val detail = listOfNotNull(temp?.let { "${Math.round(it)}°C" }, gpuMemory?.let { (label, used) -> "$label $used" }).joinToString(" · ").ifEmpty { null }
        rows += HardwareRow(name, f, MonitorFormat.percent(f), temp, detail)
    }
    s.gpu?.takeIf { it.totalMB > 0 }?.let { g ->
        rows += HardwareRow(gpuMemory!!.first, g.memFraction, MonitorFormat.percent(g.memFraction), null, gpuMemory.second)
    }
    return rows
}

@Composable
private fun HardwareDials(rows: List<HardwareRow>, size: Dp) {
    rows.forEach { r ->
        RingDial(r.fraction, r.value, r.label, r.temp?.let { "${Math.round(it)}°C" }, r.temp?.let(MonitorTone::temperature) ?: MonitorTone.OK, size)
    }
}

/** A thin ring, about the size of a letter: the minimal monitor's gauge. */
@Composable
private fun ThinRing(fraction: Double?, size: Dp = 18.dp) {
    val p = Nekko.palette
    val fill by animateFloatAsState((fraction ?: 0.0).toFloat(), label = "mini-ring")
    val tone = toneColor(MonitorTone.of(fraction))
    Canvas(Modifier.size(size)) {
        val w = 2.dp.toPx()
        val inset = w / 2
        val arc = Size(this.size.width - w, this.size.height - w)
        drawArc(p.surface2, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(w))
        if (fraction != null) drawArc(tone, -90f, 360f * fill, false, Offset(inset, inset), arc, style = Stroke(w, cap = StrokeCap.Round))
    }
}

/** One gauge of the minimal monitor and what its tooltip says in full. */
private data class MiniGauge(val name: String, val fraction: Double?, val value: String, val detail: String?, val spoken: String = "$name, $value", val models: Boolean = false)

/**
 * The minimal monitor in the mode pill: a thin ring and its percentage for the CPU, memory and
 * the first GPU, and how many models the Model Server holds. Tap for the agent's details; a mouse
 * resting on a gauge shows that reading in full (a long press moves the pill instead).
 * [compact] (a folding phone's pane) drops the percentages; [vertical] stacks the gauges, each
 * percentage under its ring (the pill docked on a side).
 */
@Composable
fun MiniMonitor(state: HardwareState, onOpen: () -> Unit, modifier: Modifier = Modifier, compact: Boolean = false, vertical: Boolean = false, modelName: (String) -> String = { it }) {
    val rows = hardwareRows(state)
    val loaded = state.engine?.resident.orEmpty()
    val models = MiniGauge(
        stringResource(R.string.monitor_loaded_models), null, "${loaded.size}",
        loaded.joinToString(", ") { modelName(it.id) }.ifEmpty { stringResource(R.string.monitor_none_loaded) },
        spoken = stringResource(R.string.monitor_models_loaded, loaded.size), models = true,
    )
    val label = stringResource(R.string.monitor)
    val gauges = (rows.take(2) + rows.drop(2).take(1)).map { MiniGauge(it.label, it.fraction, it.value, it.detail) } + models
    // The gauges sit edge to edge (no gaps), so a touch anywhere on the monitor lands on one.
    val group = Modifier.testTag(ModeTags.MONITOR).semantics { isTraversalGroup = true; contentDescription = label }
    if (vertical) {
        Column(modifier.then(group), horizontalAlignment = Alignment.CenterHorizontally) {
            gauges.forEach { g -> MiniGaugeView(g, compact = false, vertical = true, anyLoaded = loaded.isNotEmpty(), onOpen = onOpen) }
        }
    } else {
        Row(modifier.heightIn(min = 48.dp).padding(horizontal = 4.dp).then(group), verticalAlignment = Alignment.CenterVertically) {
            gauges.forEach { g -> MiniGaugeView(g, compact, vertical = false, anyLoaded = loaded.isNotEmpty(), onOpen = onOpen) }
        }
    }
}

/** A pointer resting on (or leaving) this element: a mouse, trackpad or stylus, never a finger. */
private fun Modifier.onHover(set: (Boolean) -> Unit) = pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) {
            val e = awaitPointerEvent()
            if (e.changes.firstOrNull()?.type == PointerType.Touch) continue
            when (e.type) {
                PointerEventType.Enter -> set(true)
                PointerEventType.Exit -> set(false)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)
@Composable
private fun MiniGaugeView(g: MiniGauge, compact: Boolean, vertical: Boolean, anyLoaded: Boolean, onOpen: () -> Unit) {
    val p = Nekko.palette
    val tip = rememberTooltipState(isPersistent = true)
    var overGauge by remember { mutableStateOf(false) }
    var overTip by remember { mutableStateOf(false) }
    // A mouse on the gauge or its tooltip keeps it open; moving from one to the other doesn't close it.
    LaunchedEffect(tip) {
        snapshotFlow { overGauge || overTip }.debounce(250).distinctUntilChanged().collectLatest { if (it) tip.show() }
    }
    val details = stringResource(R.string.details)
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = {
            RichTooltip(
                modifier = Modifier.onHover { overTip = it },
                title = { Text("${g.name} · ${g.value}") },
                action = {
                    TextButton(onClick = { tip.dismiss(); onOpen() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(details) }
                },
            ) { g.detail?.let { Text(it) } }
        },
        state = tip,
        // Focusable so Back and a tap outside close it, and a screen reader reaches Details.
        focusable = true,
        enableUserInput = false,
        hasAction = true,
    ) {
        val gauge = Modifier
            .heightIn(min = 48.dp)
            .widthIn(min = if (vertical) 48.dp else 0.dp)
            .clickable(role = Role.Button, onClickLabel = details, onClick = onOpen)
            .onHover { overGauge = it }
            .semantics(mergeDescendants = true) { contentDescription = g.spoken }
        val content: @Composable () -> Unit = {
            if (g.models) {
                Icon(Icons.Filled.ViewInAr, contentDescription = null, tint = if (anyLoaded) p.accent else p.inkFaint, modifier = Modifier.size(15.dp))
                Text(g.value, style = MaterialTheme.typography.labelSmall, color = p.inkSoft)
            } else {
                ThinRing(g.fraction)
                if (!compact) Text(g.value, style = MaterialTheme.typography.labelSmall, color = if (g.fraction == null) p.inkFaint else p.inkSoft, maxLines = 1)
            }
        }
        if (vertical) {
            Column(gauge.padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically)) { content() }
        } else {
            Row(
                gauge.padding(horizontal = if (compact) 3.dp else 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(if (g.models) 3.dp else 4.dp),
            ) { content() }
        }
    }
}

/**
 * The agent's details, in the card the mode pill opens into: the hardware on larger dials with
 * temperatures, the models the Model Server holds (with Unload), and, in a chat, its model and
 * effort and where its context goes.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgentDetails(
    state: HardwareState,
    chat: ChatUi?,
    computer: String,
    modelName: (String) -> String,
    onUnload: suspend (String) -> String,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var notice by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    Column(Modifier.testTag(ModeTags.MONITOR_SHEET), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionTitle(stringResource(R.string.monitor_hardware))
        if (state.system == null && state.gpu == null) {
            Footnote(state.error ?: stringResource(R.string.monitor_reading, computer))
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                HardwareDials(hardwareRows(state), 56.dp)
            }
        }
        state.system?.takeIf { it.memTotalMB > 0 }?.let { s ->
            val mem = MonitorFormat.memory(s.memUsedMB, s.memTotalMB)
            Footnote(if (s.cpuCores > 0) stringResource(R.string.monitor_cores_memory, s.cpuCores, mem) else stringResource(R.string.monitor_memory, mem))
        }
        SectionTitle(stringResource(R.string.monitor_loaded_models))
        Models(state, computer, modelName) { id ->
            notice = null
            scope.launch {
                notice = try {
                    onUnload(id) to true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    (e.message ?: "Couldn’t unload it.") to false
                }
            }
        }
        if (state.engine?.resident?.isNotEmpty() == true) Footnote(stringResource(R.string.monitor_unload_footer, computer))
        notice?.let { (text, ok) -> Text(text, style = MaterialTheme.typography.bodySmall, color = if (ok) p.ink else p.danger) }
        if (chat != null) {
            SectionTitle(stringResource(R.string.monitor_this_chat))
            BreakdownRow(stringResource(R.string.model_section), chat.modelName ?: chat.modelId ?: stringResource(R.string.model_choose), null)
            BreakdownRow(stringResource(R.string.effort_section), chat.effort?.let { effortLabel(it) } ?: stringResource(R.string.effort_computer_default), null)
            if (chat.context != null) ContextBreakdown(chat, Modifier.clip16().background(p.surface).padding(12.dp))
        }
    }
}

@Composable
private fun Footnote(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft)

@Composable
private fun Models(state: HardwareState, computer: String, modelName: (String) -> String, onUnload: (String) -> Unit) {
    val p = Nekko.palette
    val e = state.engine
    if (e == null) {
        if (state.loaded) Footnote(stringResource(R.string.monitor_no_engine, computer))
        else CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        return
    }
    when {
        !e.installed -> Footnote(stringResource(R.string.monitor_no_server, computer))
        !e.running -> Footnote(stringResource(R.string.monitor_stopped))
        e.resident.isEmpty() && e.loading.isEmpty() -> Footnote(stringResource(R.string.monitor_none_loaded))
    }
    e.resident.forEach { r -> ResidentRow(r, modelName(r.id), e.budgetBytes, state.unloading == r.id) { onUnload(r.id) } }
    e.loading.forEach { l ->
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row {
                Text(modelName(l.id), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 1, modifier = Modifier.weight(1f))
                Text(stringResource(if (l.phase == "loading") R.string.monitor_loading else R.string.monitor_queued), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            }
            val progress = l.progress
            if (progress != null) LinearProgressIndicator(progress = { progress.toFloat() }, modifier = Modifier.fillMaxWidth(), color = p.accent)
            else LinearProgressIndicator(Modifier.fillMaxWidth(), color = p.accent)
        }
    }
    val budget = e.budgetBytes?.takeIf { it > 0 } ?: return
    val used = e.resident.sumOf { it.bytes ?: 0 }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            Text(
                stringResource(
                    when (e.memoryKind) {
                        "unified" -> R.string.monitor_mem_shared
                        "ram" -> R.string.monitor_mem_ram
                        else -> R.string.monitor_mem_vram
                    },
                ),
                style = MaterialTheme.typography.bodySmall, color = p.ink, modifier = Modifier.weight(1f),
            )
            Text(stringResource(R.string.monitor_of, MonitorFormat.bytes(used), MonitorFormat.bytes(budget)), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        LinearProgressIndicator(progress = { (e.memFraction ?: 0.0).toFloat() }, modifier = Modifier.fillMaxWidth(), color = toneColor(MonitorTone.of(e.memFraction)))
    }
}

/** One model the Model Server holds: where it runs, its context and memory, and Unload. */
@Composable
private fun ResidentRow(model: EngineStatus.Resident, name: String, budget: Long?, unloading: Boolean, onUnload: () -> Unit) {
    val p = Nekko.palette
    val details = buildList {
        when (model.loadedOn) {
            "gpu" -> add(stringResource(R.string.run_gpu))
            "gpu+cpu" -> add(
                if (model.gpuLayers != null && model.totalLayers != null) stringResource(R.string.run_split_layers, model.gpuLayers!!, model.totalLayers!!)
                else stringResource(R.string.run_split),
            )
            "cpu" -> add(stringResource(R.string.run_cpu))
        }
        model.contextLength?.let { add(stringResource(R.string.model_context, MonitorFormat.tokens(it))) }
        model.bytes?.let { add(MonitorFormat.bytes(it)) }
    }.joinToString(" · ")
    val unloadLabel = stringResource(R.string.unload_named, name)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                Text(details, style = MaterialTheme.typography.bodySmall, color = if (model.split) p.warning else p.inkSoft)
            }
            TextButton(onClick = onUnload, enabled = !unloading, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = unloadLabel }) {
                if (unloading) CircularProgressIndicator(strokeWidth = 2.dp, color = p.danger, modifier = Modifier.size(16.dp))
                else Text(stringResource(R.string.unload), color = p.danger)
            }
        }
        val bytes = model.bytes
        if (budget != null && budget > 0 && bytes != null) {
            LinearProgressIndicator(progress = { min(1f, bytes.toFloat() / budget) }, modifier = Modifier.fillMaxWidth(), color = p.accent)
        }
    }
}
