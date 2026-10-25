package com.nekko.android.ui.panes

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloseFullscreen
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.components.Dot
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Hinge
import com.nekko.protocol.PaneContent
import com.nekko.protocol.PaneLayout
import com.nekko.protocol.PaneMode
import com.nekko.protocol.PaneSide
import com.nekko.protocol.PaneSplit

/** Tabletop: the pane's flex layout stops [above] from its top, where the hinge ([hinge] tall) crosses it. */
@Immutable
data class TabletopSplit(val above: Dp, val hinge: Dp)

/**
 * What a pane's view gets from [PanesHost]: where it is, whether it has the keyboard,
 * the header actions to add to its top bar (Swap, Focus, Replace with…), and what a
 * chat tapped inside it or its Back does.
 */
@Immutable
class PaneSlot(
    val side: PaneSide,
    val content: PaneContent,
    /** This pane has the keyboard; the other one's approval pulses its status dot. */
    val focused: Boolean,
    val mode: PaneMode,
    /** Tabletop only: where the hinge crosses this pane. */
    val tabletop: TabletopSplit?,
    /** Swap / Focus / Replace with…, for the pane's top bar. */
    val actions: @Composable RowScope.() -> Unit,
    /** A chat tapped in this pane ([PaneLayout.open]). */
    val open: (String) -> Unit,
    /** Back in a chat pane: the pane goes back to the chat list. */
    val back: () -> Unit,
)

/** A chat offered in Replace with…: its id and title. */
@Immutable
data class PaneChatChoice(val id: String, val title: String)

/** How a pane's content is labelled on an edge tab and in the menus. */
fun interface PaneLabels {
    fun title(content: PaneContent): String
}

/** Test tags for the instrumented posture tests. */
object PaneTags {
    const val FIRST = "pane-first"
    const val SECOND = "pane-second"
    const val DIVIDER = "pane-divider"
    const val EDGE_TAB = "pane-edge-tab"
    const val NOTE = "pane-foldable-note"
    const val TIP = "pane-chat-chat-tip"

    fun of(side: PaneSide) = if (side == PaneSide.FIRST) FIRST else SECOND
}

/**
 * The open folding phone's two panes (spec/phone/folding-phones-two-chats-and-monitors.md):
 * side by side or stacked by posture, the divider on the hinge or draggable 35–65, one
 * pane filling the screen after Focus or in tabletop (the other an edge tab), the
 * one-time *Chat + Chat* tip and the untested-on-a-foldable note above them. Each
 * pane's view comes from [content]; it moves with its pane (Swap, rotation) and keeps
 * its scroll position and composer text.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PanesHost(
    window: WindowPosture,
    layout: PaneLayout,
    onChange: ((PaneLayout) -> PaneLayout) -> Unit,
    labels: PaneLabels,
    /** Chats Replace with… offers, most recent first. */
    chats: List<PaneChatChoice>,
    /** Chats waiting on an approval or answer: their edge tab and header dot pulse. */
    waiting: Set<String>,
    /** The tip's running chat to keep beside the new one; null hides it. */
    tip: String?,
    onTakeTip: () -> Unit,
    onDismissTip: () -> Unit,
    noteDismissed: Boolean,
    onDismissNote: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (PaneSlot) -> Unit,
) {
    val p = Nekko.palette
    val density = LocalDensity.current
    val mode = window.mode
    val current by rememberUpdatedState(content)
    // Gesture handlers outlive a composition; they call the latest onChange.
    val change by rememberUpdatedState(onChange)
    // One movable view per pane content: Swap and rotation move it instead of rebuilding it.
    val views = remember { HashMap<String, @Composable (PaneSlot) -> Unit>() }
    val shown = setOf(layout.first.key, layout.second.key)
    SideEffect { views.keys.retainAll(shown) }
    fun view(key: String) = views.getOrPut(key) { movableContentOf { slot: PaneSlot -> current(slot) } }

    val banners = tip != null || !noteDismissed
    Column(modifier.fillMaxSize().background(p.paper)) {
        if (banners) {
            Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars)) {
                tip?.let { keep -> TipRow(labels.title(PaneContent.Chat(keep)), onTakeTip, onDismissTip) }
                if (!noteDismissed) FoldableNote(Modifier.testTag(PaneTags.NOTE), onDismiss = onDismissNote)
                HorizontalDivider(color = p.line)
            }
        }
        var origin by remember { mutableStateOf(Offset.Zero) }
        BoxWithConstraints(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .then(if (banners) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)
                .onPlaced { origin = it.positionInWindow() },
        ) {
            // The hinge in this box's own dp (the banners above move it up).
            val hinge = window.hinge?.relativeTo(origin.x / density.density, origin.y / density.density)
            val w = maxWidth.value
            val h = maxHeight.value
            var dragged by remember { mutableStateOf<Float?>(null) }

            fun slot(side: PaneSide, tabletop: TabletopSplit? = null) = PaneSlot(
                side = side,
                content = layout[side],
                focused = layout.focused == side,
                mode = mode,
                tabletop = tabletop,
                actions = { PaneActions(side, layout, mode, onChange, labels, chats) },
                open = { id -> onChange { it.open(id, from = side) } },
                back = { onChange { it.back(side) } },
            )

            @Composable
            fun Pane(side: PaneSide, m: Modifier, tabletop: TabletopSplit? = null) {
                val c = layout[side]
                Box(
                    m
                        .testTag(PaneTags.of(side))
                        .clipToBounds()
                        // The pane touched or typed in has the keyboard (and is the primary after a rotation).
                        .pointerInput(side) {
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                change { it.focus(side) }
                            }
                        }
                        .onFocusChanged { if (it.hasFocus) onChange { l -> l.focus(side) } },
                ) {
                    if (tabletop != null && c !is PaneContent.Chat) {
                        // A list or Monitors in tabletop: above the hinge only, nothing under it.
                        Column(Modifier.fillMaxSize()) {
                            Box(Modifier.fillMaxWidth().height(tabletop.above)) { view(c.key)(slot(side)) }
                            Spacer(Modifier.height(tabletop.hinge))
                            TabletopShelf(labels.title(layout[side.other])) { onChange { it.zoom(side.other) } }
                        }
                    } else {
                        view(c.key)(slot(side, tabletop))
                    }
                }
            }

            val zoomed = if (mode == PaneMode.TABLETOP) layout.zoomed ?: layout.focused else layout.zoomed
            when {
                zoomed != null -> Box(Modifier.fillMaxSize()) {
                    val flex = if (mode == PaneMode.TABLETOP) PaneSplit.of(PaneMode.TABLETOP, w, h, hinge, 0.5f).takeIf { it.onHinge } else null
                    val tabletop = flex?.let { TabletopSplit(it.first.dp, it.gap.dp) }
                    Pane(zoomed, Modifier.fillMaxSize(), tabletop)
                    val other = layout[zoomed.other]
                    EdgeTab(
                        title = labels.title(other),
                        waiting = (other as? PaneContent.Chat)?.id in waiting,
                        // In tabletop the tab swaps which pane shows; after Focus it brings both back.
                        onClick = { onChange { if (mode == PaneMode.TABLETOP) it.zoom(zoomed.other) else it.zoom(null) } },
                        modifier = if (tabletop != null) {
                            // Centred on the upper half: nothing under the hinge.
                            Modifier.align(Alignment.TopEnd).offset(y = (tabletop.above - EDGE_TAB_HEIGHT) / 2)
                        } else {
                            Modifier.align(Alignment.CenterEnd)
                        },
                    )
                }

                mode == PaneMode.STACKED -> {
                    val f = PaneLayout.clampSplit(dragged ?: layout.split)
                    val split = PaneSplit.of(mode, w, h, hinge, dragged ?: layout.split)
                    // A hinge-less screen shrinks both panes above the keyboard (the other pane's
                    // transcript stays in view); on Surface Duo the keyboard is on the bottom screen.
                    Column(Modifier.fillMaxSize().then(if (split.onHinge) Modifier else Modifier.imePadding())) {
                        val top = Modifier
                            .fillMaxWidth()
                            .consumeWindowInsets(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                            .then(if (split.onHinge) Modifier.consumeWindowInsets(WindowInsets.ime) else Modifier)
                        Pane(PaneSide.FIRST, if (split.onHinge) top.height(split.first.dp) else top.weight(f))
                        Divider(split, vertical = false, total = h, fraction = dragged ?: layout.split, onDrag = { dragged = it }) {
                            dragged?.let { d -> onChange { l -> l.withSplit(d) } }
                            dragged = null
                        }
                        val bottom = Modifier.fillMaxWidth().consumeWindowInsets(WindowInsets.statusBars)
                        Pane(PaneSide.SECOND, if (split.onHinge) bottom.weight(1f) else bottom.weight(1f - f))
                    }
                }

                else -> {
                    val f = PaneLayout.clampSplit(dragged ?: layout.split)
                    val split = PaneSplit.of(PaneMode.SIDE_BY_SIDE, w, h, hinge, dragged ?: layout.split)
                    Row(Modifier.fillMaxSize()) {
                        val left = Modifier.fillMaxHeight().consumeWindowInsets(WindowInsets.navigationBars.only(WindowInsetsSides.End))
                        Pane(PaneSide.FIRST, if (split.onHinge) left.width(split.first.dp) else left.weight(f))
                        Divider(split, vertical = true, total = w, fraction = dragged ?: layout.split, onDrag = { dragged = it }) {
                            dragged?.let { d -> onChange { l -> l.withSplit(d) } }
                            dragged = null
                        }
                        val right = Modifier.fillMaxHeight().consumeWindowInsets(WindowInsets.navigationBars.only(WindowInsetsSides.Start))
                        Pane(PaneSide.SECOND, if (split.onHinge) right.weight(1f) else right.weight(1f - f))
                    }
                }
            }
        }
    }
}

private val EDGE_TAB_HEIGHT = 48.dp

/**
 * The divider: the hinge itself where there is one along the split (a hairline on a
 * Fold, the gap between Surface Duo's screens), else a handle dragged between 35 / 65
 * and 65 / 35. [total] is the split axis' length in dp; [onDrag] reports the fraction.
 */
@Composable
private fun Divider(split: PaneSplit, vertical: Boolean, total: Float, fraction: Float, onDrag: (Float) -> Unit, onDragStopped: () -> Unit) {
    val p = Nekko.palette
    val density = LocalDensity.current
    if (split.onHinge) {
        val thick = maxOf(split.gap, 1f).dp
        Box(
            Modifier
                .testTag(PaneTags.DIVIDER)
                .then(if (vertical) Modifier.width(thick).fillMaxHeight() else Modifier.height(thick).fillMaxWidth())
                .background(if (split.gap > 0f) p.surface2 else p.line),
        )
        return
    }
    val base by rememberUpdatedState(fraction)
    var f by remember { mutableFloatStateOf(fraction) }
    val state = rememberDraggableState { deltaPx ->
        val usable = total - PaneSplit.DIVIDER_DP
        if (usable > 0f) {
            f = PaneLayout.clampSplit(f + deltaPx / density.density / usable)
            onDrag(f)
        }
    }
    Box(
        Modifier
            .testTag(PaneTags.DIVIDER)
            .then(if (vertical) Modifier.width(PaneSplit.DIVIDER_DP.dp).fillMaxHeight() else Modifier.height(PaneSplit.DIVIDER_DP.dp).fillMaxWidth())
            .draggable(
                state,
                if (vertical) Orientation.Horizontal else Orientation.Vertical,
                onDragStarted = { f = base },
                onDragStopped = { onDragStopped() },
            )
            .semantics { contentDescription = "Resize panes" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.then(if (vertical) Modifier.width(1.dp).fillMaxHeight() else Modifier.height(1.dp).fillMaxWidth()).background(p.line))
        Box(
            Modifier
                .then(if (vertical) Modifier.size(4.dp, 36.dp) else Modifier.size(36.dp, 4.dp))
                .clip(RoundedCornerShape(2.dp))
                .background(p.inkFaint),
        )
    }
}

/** The collapsed pane after Focus or in tabletop: a tab on the screen's edge with its title. */
@Composable
private fun EdgeTab(title: String, waiting: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Row(
        modifier
            .testTag(PaneTags.EDGE_TAB)
            .height(EDGE_TAB_HEIGHT)
            .widthIn(max = 160.dp)
            .clip(RoundedCornerShape(topStart = 12.dp, bottomStart = 12.dp))
            .background(p.surface2)
            .clickable(role = Role.Button, onClickLabel = "Show $title", onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (waiting) Dot(Tone.WARNING)
        Text(title, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Below the hinge in tabletop, when the pane on screen is the list or Monitors: nothing to tap by mistake but the other pane. */
@Composable
private fun TabletopShelf(other: String, onShowOther: () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxSize().background(p.surface).padding(16.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Lay the phone flat to see both panes.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        TextButton(onClick = onShowOther) { Text("Show $other") }
    }
}

/** The one-time tip: a second chat opened over a running one offers *Chat + Chat*. */
@Composable
private fun TipRow(keep: String, onTake: () -> Unit, onDismiss: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().testTag(PaneTags.TIP).background(p.accentSoft).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "“$keep” is still running. Watch both side by side?",
            style = MaterialTheme.typography.bodySmall,
            color = p.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onTake) { Text("Chat + Chat") }
        IconButton(onClick = onDismiss, modifier = Modifier.size(40.dp)) {
            Icon(Icons.Outlined.Close, contentDescription = "Dismiss tip", tint = p.inkFaint, modifier = Modifier.size(16.dp))
        }
    }
}

/**
 * A pane's header actions: **Swap**, **Focus** (or back to both) and **Replace with…**
 * (Monitors, Chats, another chat), the menu ending with the untested-on-a-foldable note.
 * Tabletop keeps only Replace with…: one pane shows there anyway.
 */
@Composable
private fun RowScope.PaneActions(
    side: PaneSide,
    layout: PaneLayout,
    mode: PaneMode,
    onChange: ((PaneLayout) -> PaneLayout) -> Unit,
    labels: PaneLabels,
    chats: List<PaneChatChoice>,
) {
    val p = Nekko.palette
    var menu by remember { mutableStateOf(false) }
    val zoomed = layout.zoomed == side
    if (mode != PaneMode.TABLETOP) {
        if (!zoomed) {
            IconButton(onClick = { onChange { it.swap() } }) {
                Icon(if (mode == PaneMode.STACKED) Icons.Filled.SwapVert else Icons.Filled.SwapHoriz, contentDescription = "Swap panes", tint = p.inkSoft)
            }
        }
        IconButton(onClick = { onChange { it.zoom(if (zoomed) null else side) } }) {
            Icon(
                if (zoomed) Icons.Filled.CloseFullscreen else Icons.Filled.OpenInFull,
                contentDescription = if (zoomed) "Show both panes" else "Focus this pane",
                tint = p.inkSoft,
            )
        }
    }
    Box {
        IconButton(onClick = { menu = true }) {
            Icon(Icons.Filled.Dashboard, contentDescription = "Replace with…", tint = p.inkSoft)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.widthIn(max = 320.dp)) {
            Text(
                "Replace with…",
                style = MaterialTheme.typography.labelMedium,
                color = p.inkFaint,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            val here = layout[side]
            if (here != PaneContent.Monitors) {
                DropdownMenuItem(text = { Text("Monitors") }, onClick = { menu = false; onChange { it.replace(side, PaneContent.Monitors) } })
            }
            if (here != PaneContent.Chats) {
                DropdownMenuItem(text = { Text("Chats") }, onClick = { menu = false; onChange { it.replace(side, PaneContent.Chats) } })
            }
            val onScreen = layout.chatIds.toSet()
            chats.filter { it.id !in onScreen }.take(MENU_CHATS).forEach { c ->
                DropdownMenuItem(
                    text = { Text(c.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = { menu = false; onChange { it.replace(side, PaneContent.Chat(c.id)) } },
                )
            }
            // The other pane's chat, here instead (Replace with… never shows one chat twice).
            (layout[side.other] as? PaneContent.Chat)?.id?.let { id ->
                DropdownMenuItem(
                    text = { Text("${labels.title(PaneContent.Chat(id))} (from the other pane)", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = { menu = false; onChange { it.replace(side, PaneContent.Chat(id)) } },
                )
            }
            HorizontalDivider(color = p.line)
            FoldableNote()
        }
    }
}

private const val MENU_CHATS = 8

/** [Hinge] bounds shifted into a box at [origin] (window dp). */
internal fun Hinge.relativeTo(originX: Float, originY: Float): Hinge = copy(bounds = bounds.copy(x = bounds.x - originX, y = bounds.y - originY))
