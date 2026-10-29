package com.nekko.android.ui.simple

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.unit.round
import com.nekko.android.R
import com.nekko.android.data.PillDock
import com.nekko.android.data.PillPlace
import com.nekko.android.ui.theme.Nekko
import kotlin.math.min
import kotlinx.coroutines.launch

const val PILL_TAG = "simple.pill"

/** How long a finger rests on the pill before it lifts to be moved. */
private const val LIFT_MS = 350L

/**
 * The pill's corners and the expanded card's: a capsule while small, 28 dp corners once large,
 * so one shape morphs from one to the other as its bounds grow.
 */
private val MorphShape = object : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val r = min(size.minDimension / 2, with(density) { 28.dp.toPx() })
        return Outline.Rounded(RoundRect(0f, 0f, size.width, size.height, CornerRadius(r)))
    }
}

/** The mode pill on a screen: slid away while the content scrolls on, or opened into the agent's details. */
@Stable
class ModePillState {
    var hidden by mutableStateOf(false)
    var expanded by mutableStateOf(false)

    /** The lying pill's height, which the content makes room for while it rests at the top. */
    internal var height by mutableIntStateOf(0)

    /** On the scrolling content: reading on slides the pill away, scrolling back brings it back. */
    val scroll: NestedScrollConnection = object : NestedScrollConnection {
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (consumed.y < -1f) hidden = true else if (consumed.y > 1f) hidden = false
            return Offset.Zero
        }
    }

    /** The content's top padding: the pill's height plus 8 dp while it rests at the top, else [otherwise]. */
    @Composable
    fun topInset(place: PillPlace, otherwise: androidx.compose.ui.unit.Dp = 0.dp): androidx.compose.ui.unit.Dp {
        if (!place.atTop) return otherwise
        return with(LocalDensity.current) { height.toDp() }.coerceAtLeast(48.dp) + 8.dp
    }
}

/** A pill for a screen whose content is [atStart] (scrolled all the way back): the pill always shows there. */
@Composable
fun rememberModePill(atStart: () -> Boolean): ModePillState {
    val state = remember { ModePillState() }
    LaunchedEffect(state) { snapshotFlow(atStart).collect { if (it) state.hidden = false } }
    return state
}

/**
 * The mode pill, floating over a screen's content (it takes no room): the Simple/Expert switch
 * and, when [gauges] show, the minimal monitor. It rests centered under the top bar ([barBottom],
 * root coordinates) or wherever it was moved: a long press lifts it, and let go near a side it
 * docks upright there. It moves between the bar and [floor] (the message box's top, root
 * coordinates; null for the screen's bottom). Tapping the gauges opens it into a card with
 * [details]. [visible] false (the chats list's search) slides it away.
 */
@Composable
fun ModePill(
    state: ModePillState,
    barBottom: Float,
    floor: Float?,
    gauges: (@Composable (vertical: Boolean, onOpen: () -> Unit) -> Unit)?,
    details: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
) {
    val simple = LocalSimple.current
    val place = simple.pill
    val p = Nekko.palette
    val density = LocalDensity.current
    val still = rememberReduceMotion()
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val navBottom = WindowInsets.navigationBars.getBottom(density)
    var origin by remember { mutableStateOf(Offset.Zero) }
    var box by remember { mutableStateOf(IntSize.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val vertical = place.dock != PillDock.TOP
    val canOpen = gauges != null
    LaunchedEffect(canOpen, visible) { if (!canOpen || !visible) state.expanded = false }
    if (state.expanded) BackHandler { state.expanded = false }

    // The room the pill moves in, in this overlay's own pixels.
    val gap = with(density) { 4.dp.toPx() }
    val top = barBottom - origin.y + gap
    val bottom = (floor?.let { it - origin.y } ?: (box.height - navBottom).toFloat()) - gap
    val room = (bottom - top - size.height).coerceAtLeast(0f)
    val side = with(density) { 12.dp.toPx() }
    val target = if (size == IntSize.Zero || box == IntSize.Zero) null else Offset(
        when (place.dock) {
            PillDock.LEFT -> side
            PillDock.RIGHT -> box.width - side - size.width
            PillDock.TOP -> (box.width - size.width) / 2f
        },
        top + place.y * room,
    )

    val pos = remember { Animatable(Offset.Zero, Offset.VectorConverter) }
    var placed by remember { mutableStateOf(false) }
    var lifted by remember { mutableStateOf(false) }
    LaunchedEffect(target, lifted) {
        if (target == null || lifted) return@LaunchedEffect
        if (!placed || still) {
            pos.snapTo(target)
            placed = true
        } else {
            pos.animateTo(target, spring(dampingRatio = 0.72f, stiffness = Spring.StiffnessMediumLow))
        }
    }

    val away = state.hidden || !visible
    val hide by animateFloatAsState(if (away) 1f else 0f, if (still) snap() else spring(stiffness = Spring.StiffnessMediumLow), label = "pill-hide")
    val lift by animateFloatAsState(if (lifted) 1f else 0f, if (still) snap() else spring(), label = "pill-lift")

    // The gesture reads these as they are now, not as they were when it started.
    val now by rememberUpdatedState(Triple(top, room, box))
    val currentSize by rememberUpdatedState(size)
    val snapPx = with(density) { 72.dp.toPx() }
    val moveTo: (PillPlace) -> Unit = { if (it != place) simple.setPill(it) }

    val morph = BoundsTransform { _, _ -> if (still) snap() else spring(dampingRatio = 0.76f, stiffness = 420f) }
    val fadeInContent = if (still) EnterTransition.None else fadeIn(tween(220, delayMillis = 60))
    val fadeOutContent = if (still) ExitTransition.None else fadeOut(tween(120))

    SharedTransitionLayout(
        modifier.fillMaxSize().onGloballyPositioned {
            origin = it.positionInRoot()
            box = it.size
        },
    ) {
        val clip = OverlayClip(MorphShape)
        Box(Modifier.fillMaxSize()) {
            // The rest of the screen dims under the open card; a tap on it closes the card.
            AnimatedVisibility(state.expanded, enter = if (still) EnterTransition.None else fadeIn(), exit = if (still) ExitTransition.None else fadeOut()) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f)).pointerInput(Unit) { detectTapGestures { state.expanded = false } })
            }

            val gone = away && hide >= 1f && !state.expanded
            if (!gone) {
                AnimatedVisibility(
                    !state.expanded,
                    modifier = Modifier.offset { pos.value.round() }.graphicsLayer { alpha = if (placed) 1f else 0f },
                    enter = EnterTransition.None,
                    exit = ExitTransition.None,
                ) {
                    val moveTop = stringResource(R.string.pill_move_top)
                    val dockLeft = stringResource(R.string.pill_dock_left)
                    val dockRight = stringResource(R.string.pill_dock_right)
                    Box(
                        Modifier
                            .graphicsLayer {
                                val (t, _, b) = now
                                when (place.dock) {
                                    PillDock.TOP -> translationY = -(t + size.height) * hide
                                    PillDock.LEFT -> translationX = -(pos.value.x + size.width) * hide
                                    PillDock.RIGHT -> translationX = (b.width - pos.value.x) * hide
                                }
                                alpha = 1f - hide
                                scaleX = 1f + 0.05f * lift
                                scaleY = 1f + 0.05f * lift
                            }
                            .sharedBounds(
                                rememberSharedContentState(PILL_TAG), this@AnimatedVisibility,
                                enter = fadeInContent, exit = fadeOutContent, boundsTransform = morph,
                                resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
                                clipInOverlayDuringTransition = clip,
                            )
                            .shadow(lerp(4.dp, 14.dp, lift), MorphShape, clip = false)
                            // Nearly solid: Compose has no backdrop blur here, so text behind a see-through pill reads through it.
                            .background(p.surface.copy(alpha = 0.96f), MorphShape)
                            .border(1.dp, p.line, MorphShape)
                            .clip(MorphShape)
                            .then(if (vertical) Modifier.systemGestureExclusion() else Modifier)
                            .testTag(PILL_TAG)
                            .semantics {
                                isTraversalGroup = true
                                customActions = listOf(
                                    CustomAccessibilityAction(moveTop) { moveTo(PillPlace.DEFAULT); true },
                                    CustomAccessibilityAction(dockLeft) { moveTo(PillPlace(PillDock.LEFT, place.y)); true },
                                    CustomAccessibilityAction(dockRight) { moveTo(PillPlace(PillDock.RIGHT, place.y)); true },
                                )
                            }
                            .pointerInput(Unit) {
                                liftAndDrag(
                                    onLift = {
                                        lifted = true
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    },
                                    onMove = { delta ->
                                        scope.launch {
                                            val (t, r, b) = now
                                            val s = currentSize
                                            val next = pos.value + delta
                                            pos.snapTo(Offset(next.x.coerceIn(0f, (b.width - s.width).toFloat().coerceAtLeast(0f)), next.y.coerceIn(t, t + r)))
                                        }
                                    },
                                    onDrop = { grab ->
                                        scope.launch {
                                            val (t, r, b) = now
                                            val at = pos.value
                                            val next = PillPlace.release(at.x + grab.x, b.width.toFloat(), at.y - t, r, snapPx)
                                            moveTo(next)
                                            lifted = false
                                            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                                        }
                                    },
                                )
                            },
                    ) {
                        // Its natural size whatever bounds the morph gives it, so it fades rather than squashes.
                        // Bounded again inside, or the switch's weighted segments measure to nothing.
                        Box(Modifier.wrapContentSize(unbounded = true).sizeIn(maxWidth = 640.dp, maxHeight = 640.dp).onSizeChanged { size = it; if (!vertical) state.height = it.height }) {
                            val open = { if (canOpen) state.expanded = true }
                            if (vertical) {
                                Column(Modifier.padding(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                    ModeSwitch(simple.expert, simple.setExpert, vertical = true)
                                    if (gauges != null) {
                                        Box(Modifier.padding(vertical = 4.dp).size(width = 24.dp, height = 1.dp).background(p.line))
                                        gauges(true, open)
                                    }
                                }
                            } else {
                                Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                    ModeSwitch(simple.expert, simple.setExpert)
                                    if (gauges != null) {
                                        Box(Modifier.padding(horizontal = 4.dp).size(width = 1.dp, height = 22.dp).background(p.line))
                                        gauges(false, open)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // The agent's details, the pill grown into a card under the top bar.
            val cardTop = with(density) { (barBottom - origin.y).toDp() } + 8.dp
            val cardWidth = with(density) { box.width.toDp() } - 24.dp
            val cardMax = (with(density) { (bottom - (barBottom - origin.y)).toDp() } - 16.dp).coerceAtLeast(120.dp)
            AnimatedVisibility(
                state.expanded,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = cardTop),
                enter = EnterTransition.None,
                exit = ExitTransition.None,
            ) {
                var pull by remember { mutableFloatStateOf(0f) }
                val close = { state.expanded = false }
                Box(
                    Modifier
                        .graphicsLayer { translationY = pull }
                        .sharedBounds(
                            rememberSharedContentState(PILL_TAG), this@AnimatedVisibility,
                            enter = fadeInContent, exit = fadeOutContent, boundsTransform = morph,
                            resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
                            clipInOverlayDuringTransition = clip,
                        )
                        .shadow(12.dp, MorphShape, clip = false)
                        .background(p.paper, MorphShape)
                        .clip(MorphShape),
                ) {
                    Column(
                        Modifier
                            .wrapContentSize(Alignment.TopCenter, unbounded = true)
                            .requiredWidth(cardWidth.coerceAtLeast(120.dp))
                            .heightIn(max = cardMax)
                            .nestedScroll(rememberPullToClose({ pull }, { pull = it }, close))
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 20.dp)
                            .padding(top = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.monitor), style = MaterialTheme.typography.titleMedium, color = p.ink)
                            Spacer(Modifier.weight(1f))
                            TextButton(onClick = close, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.pill_done), color = p.accent) }
                        }
                        details()
                        // The grab handle: swipe the card up to close it.
                        Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                            Box(Modifier.size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(2.dp)).background(p.line))
                        }
                    }
                }
            }
        }
    }
}

/**
 * A swipe up the card, once its content can't scroll further, pulls it up ([pull] goes negative);
 * far enough or fast enough closes it, and a swipe back down puts it back.
 */
@Composable
private fun rememberPullToClose(pull: () -> Float, setPull: (Float) -> Unit, onClose: () -> Unit): NestedScrollConnection {
    val close by rememberUpdatedState(onClose)
    return remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                val drag = pull()
                if (drag < 0f && available.y > 0f) {
                    val take = minOf(available.y, -drag)
                    setPull(drag + take)
                    return Offset(0f, take)
                }
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y < 0f) {
                    setPull(pull() + available.y)
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                val drag = pull()
                if (drag < -150f || (drag < 0f && available.y < -1500f)) close()
                setPull(0f)
                return Velocity.Zero
            }
        }
    }
}

/**
 * A long press ([LIFT_MS]) lifts the pill, then it follows the finger until let go. It watches
 * before the switch and the gauges do, so a press on either still lifts it; a tap, or a finger
 * that moves first, is left to them. Once lifted the touch is the pill's alone. [onDrop] gets
 * where on the pill the finger held it.
 */
private suspend fun PointerInputScope.liftAndDrag(onLift: () -> Unit, onMove: (Offset) -> Unit, onDrop: (Offset) -> Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        val early = withTimeoutOrNull(LIFT_MS) {
            var gone = false
            while (!gone) {
                val c = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id }
                gone = c == null || !c.pressed || (c.position - down.position).getDistance() > viewConfiguration.touchSlop
            }
            true
        }
        if (early == true) return@awaitEachGesture
        onLift()
        var grab = down.position
        while (true) {
            val c = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
            if (!c.pressed) {
                c.consume()
                break
            }
            onMove(c.positionChange())
            grab = c.position
            c.consume()
        }
        onDrop(grab)
    }
}
