package com.nekko.android.ui.simple

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SimpleMode
import com.nekko.android.data.SimpleVisibility
import com.nekko.android.monitors.EXPERT_MODE
import com.nekko.android.monitors.HardwareMonitorController
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.roundToInt
import com.nekko.android.ui.theme.Nekko

/**
 * The mode and the person's choices, as the screens read them. [localModelLoaded] is the
 * screen's own last Model Server read: while it holds a model, Simple shows the monitors too.
 */
class SimpleView(
    val expert: Boolean,
    val choices: Map<String, SimpleVisibility>,
    val localModelLoaded: Boolean = false,
    val setExpert: (Boolean) -> Unit,
) {
    fun shown(id: String) = SimpleMode.shown(id, expert, choices, localModelLoaded)

    fun visibility(id: String) = SimpleMode.visibility(id, choices)

    fun withLocalModel(loaded: Boolean) = if (loaded == localModelLoaded) this else SimpleView(expert, choices, loaded, setExpert)

    companion object {
        /** Outside the app's provider (previews, tests of one component): every control shows. */
        val ALL = SimpleView(expert = true, choices = emptyMap()) {}
    }
}

val LocalSimple = staticCompositionLocalOf { SimpleView.ALL }

@Composable
fun rememberSimpleView(prefs: PhonePrefs): SimpleView {
    val expert by prefs.flow(EXPERT_MODE).collectAsStateWithLifecycle()
    val raw by prefs.flow(SimpleMode.CHOICES).collectAsStateWithLifecycle()
    return remember(expert, raw, prefs) { SimpleView(expert, SimpleMode.parse(raw)) { prefs.set(EXPERT_MODE, it) } }
}

/** A pill of segments, the selected one tinted with the accent. */
@Composable
fun <T> Segments(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    height: Dp = 40.dp,
    describe: (T) -> String,
    content: @Composable RowScope.(option: T, on: Boolean) -> Unit,
) {
    val p = Nekko.palette
    val shape = RoundedCornerShape(999.dp)
    Row(
        modifier.clip(shape).background(p.surface2).border(1.dp, p.line, shape).padding(2.dp).selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { o ->
            val on = o == selected
            Row(
                Modifier
                    .weight(1f, fill = false)
                    .heightIn(min = height)
                    .widthIn(min = 48.dp)
                    .clip(shape)
                    .background(if (on) p.accent else p.surface2)
                    .selectable(on, role = Role.RadioButton) { if (!on) onSelect(o) }
                    .semantics { contentDescription = describe(o) }
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) { content(o, on) }
        }
    }
}

/** Text segments: Simple | Expert, or Show / Expert only / Hide. */
@Composable
fun <T> TextSegments(options: List<T>, selected: T, onSelect: (T) -> Unit, label: (T) -> String, modifier: Modifier = Modifier, describe: (T) -> String = label) {
    val p = Nekko.palette
    Segments(options, selected, onSelect, modifier, describe = describe) { o, on ->
        Text(
            label(o), style = MaterialTheme.typography.labelLarge, color = if (on) p.accentInk else p.ink,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(min = 40.dp),
        )
    }
}

const val MODE_SWITCH_TAG = "simple.mode"
const val SIMPLE_DESCRIPTION = "Simple: everyday controls"
const val EXPERT_DESCRIPTION = "Expert: every control"

/** Simple (a chat bubble) or Expert (angle brackets), at the left of the slim row under the header. */
@Composable
fun ModeSwitch(expert: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Box(modifier.testTag(MODE_SWITCH_TAG)) {
        Segments(
            options = listOf(false, true), selected = expert, onSelect = onChange, height = 26.dp,
            describe = { if (it) EXPERT_DESCRIPTION else SIMPLE_DESCRIPTION },
        ) { o, on ->
            Icon(
                if (o) Icons.Filled.Code else Icons.Filled.ChatBubbleOutline,
                contentDescription = null,
                tint = if (on) p.accentInk else p.inkSoft,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/**
 * The slim second row under a header: the mode switch on the left, the minimal monitor (or
 * nothing) on the right, and a hairline under it.
 */
@Composable
fun SlimBar(expert: Boolean, onExpert: (Boolean) -> Unit, modifier: Modifier = Modifier, end: @Composable () -> Unit = {}) {
    Column(modifier.fillMaxWidth().background(Nekko.palette.paper)) {
        Row(Modifier.fillMaxWidth().height(34.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            ModeSwitch(expert, onExpert)
            Spacer(Modifier.weight(1f))
            end()
        }
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    }
}

/**
 * Reads the computer's hardware every 3 s while the monitor shows ([full]), else only its Model
 * Server every 10 s while a loaded local model could bring the monitors into Simple ([light]).
 * Only while the screen is started and the computer is online.
 */
@Composable
fun PollHardware(hardware: HardwareMonitorController, online: Boolean, full: Boolean, light: Boolean) {
    if (!online || !(full || light)) return
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(hardware, lifecycle, full) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { if (full) hardware.poll() else hardware.pollEngine() }
    }
}

/**
 * A minimal panel that slides down from under the header over a light scrim. Tapping the scrim,
 * swiping it up, or Back closes it.
 */
@Composable
fun PullDownPanel(open: Boolean, onDismiss: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val p = Nekko.palette
    val scrim by animateFloatAsState(if (open) 0.32f else 0f, label = "panel-scrim")
    val dismiss by rememberUpdatedState(onDismiss)
    if (open) BackHandler(onBack = onDismiss)
    var drag by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(open) { drag = 0f }
    // A swipe up the panel, once its content can't scroll further, pulls it up; far enough or fast enough closes it.
    val pull = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (drag < 0f && available.y > 0f) {
                    val take = minOf(available.y, -drag)
                    drag += take
                    return Offset(0f, take)
                }
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y < 0f) {
                    drag += available.y
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (drag < -150f || (drag < 0f && available.y < -1500f)) dismiss()
                drag = 0f
                return Velocity.Zero
            }
        }
    }
    Box(modifier.fillMaxSize()) {
        if (scrim > 0f) {
            Box(
                Modifier.fillMaxSize().background(Color.Black.copy(alpha = scrim))
                    .pointerInput(open) { if (open) detectTapGestures { dismiss() } },
            )
        }
        AnimatedVisibility(open, enter = slideInVertically { -it } + fadeIn(), exit = slideOutVertically { -it } + fadeOut()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .offset { IntOffset(0, drag.roundToInt()) }
                    .clip(RoundedCornerShape(bottomStart = 20.dp, bottomEnd = 20.dp))
                    .background(p.paper)
                    .heightIn(max = 600.dp)
                    .nestedScroll(pull)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp)
                    .padding(top = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                content()
                // The grab handle: swipe up anywhere on the panel to close it.
                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(2.dp)).background(p.line))
                }
            }
        }
    }
}
