package com.nekko.protocol

/**
 * How the phone is held, which decides the folding-phone layout
 * (spec/phone/folding-phones-two-chats-and-monitors.md, *Postures*). Read from
 * the system (Jetpack WindowManager's `FoldingFeature` and the window size
 * class), never from a device list. The same model as NekkoKit's
 * `Posture.swift`; both are held to the shared `posture.json` fixture.
 *
 * Pure JVM on purpose: the app maps `WindowInfoTracker.windowLayoutInfo` and
 * `calculateWindowSizeClass` into these plain types, so the rules are tested
 * without an Android runtime.
 */
enum class Posture {
    /** One column: any phone, a Fold's cover screen, anything under 600 dp wide. */
    CLOSED,

    /** Two panes side by side (landscape or near-square). */
    OPEN_WIDE,

    /** Two panes stacked ("vertical mode"). */
    OPEN_TALL,

    /** Half opened with a horizontal hinge: transcript above, composer below. */
    TABLETOP,

    /** Half opened with a vertical hinge: as open, wide, the divider on the hinge. */
    BOOK,
    ;

    companion object {
        /** Below this width the app is always one column (a Flip's open inner screen). */
        const val MIN_OPEN_WIDTH_DP = 600f

        /** Taller than this (height / width) is open, tall; anything squarer is open, wide. */
        const val TALL_ASPECT = 1.3f

        /** The posture for these inputs (the same rules as `Posture.from` in Swift). */
        fun from(input: PostureInput): Posture {
            if (input.widthDp < MIN_OPEN_WIDTH_DP ||
                input.widthClass == WindowClass.COMPACT ||
                input.heightClass == WindowClass.COMPACT
            ) {
                return CLOSED
            }
            val hinge = input.hinge
            if (hinge != null && hinge.state == Hinge.State.HALF_OPENED) {
                return if (hinge.orientation == Hinge.Orientation.HORIZONTAL) TABLETOP else BOOK
            }
            return if (input.heightDp / input.widthDp > TALL_ASPECT) OPEN_TALL else OPEN_WIDE
        }
    }
}

/** A window size class (Material 3 adaptive's width or height class). */
enum class WindowClass { COMPACT, MEDIUM, EXPANDED }

/** A `FoldingFeature` as plain data, its bounds in the window's dp. */
data class Hinge(
    val bounds: Bounds,
    val state: State,
    val orientation: Orientation,
    /** Two screens with a gap between them (Surface Duo): the divider is the gap. */
    val isSeparating: Boolean = false,
) {
    data class Bounds(val x: Float, val y: Float, val width: Float, val height: Float)

    enum class State { FLAT, HALF_OPENED }

    enum class Orientation { HORIZONTAL, VERTICAL }
}

/** Everything the posture is worked out from. */
data class PostureInput(
    val widthDp: Float,
    val heightDp: Float,
    val widthClass: WindowClass,
    val heightClass: WindowClass,
    val hinge: Hinge? = null,
)
