package com.nekko.android.ui.panes

import android.app.Activity
import android.graphics.Rect
import androidx.activity.compose.LocalActivity
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.window.core.layout.WindowSizeClass
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
import com.nekko.protocol.Hinge
import com.nekko.protocol.PaneMode
import com.nekko.protocol.Posture
import com.nekko.protocol.PostureInput
import com.nekko.protocol.WindowClass

/**
 * How the phone is held right now, read from the system: Jetpack WindowManager's
 * `FoldingFeature` (state, orientation, bounds, separating) and Material 3 adaptive's
 * window size class, mapped into [Posture.from]'s plain inputs. Never a device list.
 * [hinge] and the size are in the window's dp.
 */
@Immutable
data class WindowPosture(
    val posture: Posture,
    val hinge: Hinge?,
    val widthDp: Float,
    val heightDp: Float,
) {
    val mode: PaneMode get() = PaneMode.of(posture, hinge)

    companion object {
        /** No activity (previews) or nothing read yet: today's one-column app. */
        val CLOSED = WindowPosture(Posture.CLOSED, null, 0f, 0f)

        /** Material's width breakpoints (dp): medium from 600, expanded from 840. */
        const val WIDTH_MEDIUM = 600
        const val WIDTH_EXPANDED = 840

        /** Material's height breakpoints (dp): medium from 480, expanded from 900. */
        const val HEIGHT_MEDIUM = 480
        const val HEIGHT_EXPANDED = 900

        fun windowClass(atLeastMedium: Boolean, atLeastExpanded: Boolean): WindowClass = when {
            atLeastExpanded -> WindowClass.EXPANDED
            atLeastMedium -> WindowClass.MEDIUM
            else -> WindowClass.COMPACT
        }

        fun widthClass(c: WindowSizeClass) =
            windowClass(c.isWidthAtLeastBreakpoint(WIDTH_MEDIUM), c.isWidthAtLeastBreakpoint(WIDTH_EXPANDED))

        fun heightClass(c: WindowSizeClass) =
            windowClass(c.isHeightAtLeastBreakpoint(HEIGHT_MEDIUM), c.isHeightAtLeastBreakpoint(HEIGHT_EXPANDED))

        /** A hinge from its bounds in window pixels; [density] is pixels per dp. */
        fun hinge(bounds: Rect, halfOpened: Boolean, horizontal: Boolean, separating: Boolean, density: Float): Hinge = Hinge(
            bounds = Hinge.Bounds(bounds.left / density, bounds.top / density, bounds.width() / density, bounds.height() / density),
            state = if (halfOpened) Hinge.State.HALF_OPENED else Hinge.State.FLAT,
            orientation = if (horizontal) Hinge.Orientation.HORIZONTAL else Hinge.Orientation.VERTICAL,
            isSeparating = separating,
        )

        /**
         * The fold in [info], as a [Hinge]. Samsung's Flex mode and Pixel Fold's tabletop
         * both arrive as HALF_OPENED with a horizontal hinge; Surface Duo's two screens as
         * a separating feature whose bounds are the gap between them.
         */
        fun hinge(info: WindowLayoutInfo?, density: Float): Hinge? {
            val fold = info?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull() ?: return null
            return hinge(
                fold.bounds,
                halfOpened = fold.state == FoldingFeature.State.HALF_OPENED,
                horizontal = fold.orientation == FoldingFeature.Orientation.HORIZONTAL,
                separating = fold.isSeparating,
                density = density,
            )
        }
    }
}

/** The posture for the activity's window, updated as the phone folds, unfolds and rotates. */
@Composable
fun rememberWindowPosture(): WindowPosture {
    val activity: Activity = LocalActivity.current ?: return WindowPosture.CLOSED
    val layoutInfo by remember(activity) { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity) }
        .collectAsStateWithLifecycle(initialValue = null)
    val sizeClass = currentWindowAdaptiveInfo().windowSizeClass
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current.density
    val bounds = remember(activity, configuration) { WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(activity).bounds }
    val hinge = WindowPosture.hinge(layoutInfo, density)
    val input = PostureInput(
        widthDp = bounds.width() / density,
        heightDp = bounds.height() / density,
        widthClass = WindowPosture.widthClass(sizeClass),
        heightClass = WindowPosture.heightClass(sizeClass),
        hinge = hinge,
    )
    return remember(input) { WindowPosture(Posture.from(input), hinge, input.widthDp, input.heightDp) }
}
