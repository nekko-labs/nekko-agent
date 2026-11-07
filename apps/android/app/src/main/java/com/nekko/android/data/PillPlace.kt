package com.nekko.android.data

/** Where the floating mode pill rests: lying along the screen ([TOP]), or upright against a side. */
enum class PillDock { TOP, LEFT, RIGHT }

/**
 * Where the mode pill rests, one place for the whole phone (chats and the chats list alike).
 * [y] is how far down its room the pill sits: 0 just under the top bar, 1 on the message box
 * (or the bottom of the list). [atTop] is the default, where the content makes room for it.
 * [tucked]: swiped into its edge (a side, or the top bar), only a slim arrow tab shows.
 */
data class PillPlace(val dock: PillDock = PillDock.TOP, val y: Float = 0f, val tucked: Boolean = false) {
    val atTop: Boolean get() = dock == PillDock.TOP && y == 0f && !tucked

    /** It rests against an edge it can be swiped into: a side, or the top bar. */
    val canTuck: Boolean get() = dock != PillDock.TOP || y == 0f

    /** Whether a swipe of ([dx], [dy]) goes into the pill's edge, at least [min] along it. */
    fun swipesIn(dx: Float, dy: Float, min: Float): Boolean = canTuck && when (dock) {
        PillDock.TOP -> -dy > min && -dy > kotlin.math.abs(dx)
        PillDock.LEFT -> -dx > min && -dx > kotlin.math.abs(dy)
        PillDock.RIGHT -> dx > min && dx > kotlin.math.abs(dy)
    }

    companion object {
        val DEFAULT = PillPlace()

        /** Let go within this share of the width from a side, the pill docks upright on that side. */
        const val EDGE = 0.22f

        val KEY: PhonePrefs.Key<PillPlace> = PhonePrefs.key("pill.place", DEFAULT, { "${it.dock.name}:${it.y}" + if (it.tucked) ":TUCKED" else "" }, ::decode)

        internal fun decode(stored: String): PillPlace? {
            val parts = stored.split(':')
            if (parts.size != 2 && !(parts.size == 3 && parts[2] == "TUCKED")) return null
            val dock = PillDock.entries.firstOrNull { it.name == parts[0] } ?: return null
            val y = parts[1].toFloatOrNull()?.takeIf { it.isFinite() } ?: return null
            val place = PillPlace(dock, y.coerceIn(0f, 1f))
            return place.copy(tucked = parts.size == 3 && place.canTuck)
        }

        /**
         * Where a pill let go of comes to rest. [x] is the finger across a [width]-wide screen;
         * [top] is the pill's top edge measured down from its highest spot, [room] how far below
         * that it can go, and a horizontal pill let go within [snap] of the top goes home.
         */
        fun release(x: Float, width: Float, top: Float, room: Float, snap: Float): PillPlace {
            val dock = when {
                x < width * EDGE -> PillDock.LEFT
                x > width * (1 - EDGE) -> PillDock.RIGHT
                else -> PillDock.TOP
            }
            val y = top.coerceIn(0f, room.coerceAtLeast(0f))
            if (dock == PillDock.TOP && y <= snap) return DEFAULT
            return PillPlace(dock, if (room > 0f) y / room else 0f)
        }
    }
}
