package com.nekko.android.ui.theme

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

enum class SeasonalDecoration {
    NONE, WINTER, SPOOKY;

    companion object {
        fun from(preset: ThemePreset?) = when (preset?.id) {
            "winter" -> WINTER
            "autumn" -> SPOOKY
            else -> NONE
        }
    }
}

val LocalSeasonalDecoration = staticCompositionLocalOf { SeasonalDecoration.NONE }

/**
 * Ten flakes in the air at once, each in one of eight designs. Every fall picks a new
 * design, column and size at random; each flake's (slow) speed and spin are random per
 * launch. The same model, designs and hash as iOS.
 */
internal object WinterFlakes {
    const val COUNT = 10
    /** Radius range (dp) and seconds per fall: large and always slow. */
    const val MIN_RADIUS = 8.0
    const val MAX_RADIUS = 14.0
    const val MIN_FALL = 48.0
    const val MAX_FALL = 96.0

    data class Flake(val position: Offset, val type: Int, val radius: Float, val angle: Float)

    /**
     * One arm pointing up from the centre of a 24 x 24 box, repeated six times, plus beads
     * on each arm and an optional centre ring. Matches the desktop's `SNOWFLAKE_TYPES`.
     */
    class Design(val lines: List<List<Pair<Double, Double>>>, val beads: List<Triple<Double, Double, Double>> = emptyList(), val ring: Double? = null)

    val designs = listOf(
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 2.0), listOf(9.6 to 4.4, 12.0 to 6.6, 14.4 to 4.4))),
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 2.0), listOf(10.5 to 3.5, 12.0 to 5.0, 13.5 to 3.5), listOf(9.9 to 5.9, 12.0 to 7.6, 14.1 to 5.9))),
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 4.8)), beads = listOf(Triple(12.0, 3.2, 1.2))),
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 2.0), listOf(10.0 to 4.6, 14.0 to 4.6), listOf(10.6 to 7.6, 13.4 to 7.6))),
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 6.4), listOf(12.0 to 6.4, 10.4 to 4.0, 12.0 to 1.6, 13.6 to 4.0, 12.0 to 6.4))),
        Design(listOf(listOf(12.0 to 12.0, 12.0 to 2.0), listOf(10.2 to 3.8, 12.0 to 2.0, 13.8 to 3.8), listOf(10.7 to 6.5, 12.0 to 5.2, 13.3 to 6.5))),
        Design(listOf(listOf(12.0 to 8.6, 12.0 to 2.4), listOf(10.6 to 4.4, 12.0 to 5.8, 13.4 to 4.4), listOf(12.0 to 8.6, 14.98 to 10.3))),
        Design(listOf(listOf(12.0 to 9.6, 12.0 to 2.0), listOf(9.4 to 5.6, 12.0 to 7.2, 14.6 to 5.6), listOf(10.4 to 3.6, 12.0 to 4.6, 13.6 to 3.6)), ring = 2.4),
    )
    val TYPE_COUNT = designs.size

    /** Where flake [index] is after [seconds], for this launch's [seed]. */
    fun flake(index: Int, seconds: Double, seed: Long): Flake {
        val period = MIN_FALL + (MAX_FALL - MIN_FALL) * unit(seed, index, -1, 0)
        val progress = unit(seed, index, -1, 1) + seconds / period
        val cycle = floor(progress).toInt()
        val y = progress - cycle
        val spin = if (unit(seed, index, -1, 2) < 0.5) -1.0 else 1.0
        val column = 0.04 + unit(seed, index, cycle, 3) * 0.92
        return Flake(
            Offset((column + sin(seconds / 9 + index) * 0.02).toFloat(), y.toFloat()),
            minOf(TYPE_COUNT - 1, (unit(seed, index, cycle, 4) * TYPE_COUNT).toInt()),
            (MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * unit(seed, index, cycle, 5)).toFloat(),
            (spin * y * 2.3).toFloat(),
        )
    }

    /** Design [type] at radius 1, centred on the origin. */
    fun path(type: Int) = Path().apply {
        val design = designs[type]
        repeat(6) { arm ->
            val angle = arm * Math.PI / 3
            fun point(x: Double, y: Double): Offset {
                val along = (12 - y) / 10
                val across = (x - 12) / 10
                return Offset((along * sin(angle) + across * cos(angle)).toFloat(), (-along * cos(angle) + across * sin(angle)).toFloat())
            }
            for (line in design.lines) {
                point(line[0].first, line[0].second).let { moveTo(it.x, it.y) }
                for ((x, y) in line.drop(1)) point(x, y).let { lineTo(it.x, it.y) }
            }
            for ((x, y, r) in design.beads) {
                val c = point(x, y)
                val rr = (r / 10).toFloat()
                addOval(Rect(c.x - rr, c.y - rr, c.x + rr, c.y + rr))
            }
        }
        design.ring?.let { val rr = (it / 10).toFloat(); addOval(Rect(-rr, -rr, rr, rr)) }
    }

    /** The classic design, also stitched on the Winter beanie. */
    fun snowflake() = path(0)

    /** A repeatable number in 0 until 1 (SplitMix64), the same as iOS. */
    fun unit(seed: Long, index: Int, cycle: Int, salt: Int): Double {
        var z = seed + index.toLong() * -0x61c8864680b583ebL + cycle.toLong() * -0x40a7b892e31b1a47L + salt.toLong() * -0x6b2fb644ecceee15L
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        z = z xor (z ushr 31)
        return (z ushr 11).toDouble() / (1L shl 53).toDouble()
    }
}

private fun polygon(vararg points: Pair<Float, Float>) = Path().apply {
    points.forEachIndexed { index, (x, y) -> if (index == 0) moveTo(x, y) else lineTo(x, y) }
    close()
}

/** Draw only: no pointer handler or accessibility nodes, and no clock while stopped. */
@Composable
fun WinterSnow(modifier: Modifier = Modifier) {
    val resolver = LocalContext.current.contentResolver
    var still by remember(resolver) { mutableStateOf(Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                still = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
            }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val elapsed = remember { mutableDoubleStateOf(0.0) }
    LaunchedEffect(lifecycle, still) {
        if (still) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            var previous = android.os.SystemClock.elapsedRealtimeNanos()
            while (true) {
                delay(50)
                val now = android.os.SystemClock.elapsedRealtimeNanos()
                elapsed.doubleValue += (now - previous) / 1_000_000_000.0
                previous = now
            }
        }
    }
    val color = Nekko.palette.accent.copy(alpha = 0.18f)
    val seed = remember { kotlin.random.Random.nextLong() }
    val paths = remember { List(WinterFlakes.TYPE_COUNT) { WinterFlakes.path(it) } }
    Canvas(modifier.clearAndSetSemantics { }) {
        val seconds = if (still) 0.0 else elapsed.doubleValue
        val margin = 2 * WinterFlakes.MAX_RADIUS.toFloat() * density
        repeat(WinterFlakes.COUNT) { index ->
            val flake = WinterFlakes.flake(index, seconds, seed)
            val radius = flake.radius * density
            translate(flake.position.x * size.width, flake.position.y * (size.height + 2 * margin) - margin) {
                rotate(Math.toDegrees(flake.angle.toDouble()).toFloat(), pivot = Offset.Zero) {
                    scale(radius, radius, pivot = Offset.Zero) {
                        drawPath(paths[flake.type], color,
                            style = Stroke(1.2f * density / radius, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }
                }
            }
        }
    }
}

/** Hat on the existing 32 x 32 cat grid; eyes and touch target are unchanged. */
@Composable
fun MascotHat(decoration: SeasonalDecoration, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Canvas(modifier.clearAndSetSemantics { }) {
        scale(size.width / 32, size.height / 32, pivot = Offset.Zero) {
            when (decoration) {
                SeasonalDecoration.WINTER -> {
                    val crown = polygon(4f to 10f, 4f to 2f, 10f to 5f, 16f to 4f, 22f to 5f, 28f to 2f, 28f to 10f)
                    drawPath(crown, p.danger)
                    drawPath(crown, p.accent.copy(alpha = 0.22f))
                    drawPath(crown, p.paper.copy(alpha = 0.25f))
                    drawPath(crown, p.ink.copy(alpha = 0.7f), style = Stroke(0.6f))
                    brim(p.ink, 3f, 9f, 26f, 4f)
                    for (x in 5..27 step 2) drawRect(p.paper.copy(alpha = 0.25f), Offset(x.toFloat(), 10f), Size(0.5f, 2f))
                    translate(16f, 7f) { scale(2f, 2f, pivot = Offset.Zero) { drawPath(WinterFlakes.snowflake(), p.ink, style = Stroke(0.35f)) } }
                }
                SeasonalDecoration.SPOOKY -> {
                    val crown = polygon(6f to 10f, 13f to 0.5f, 22f to 2f, 17f to 3f, 25f to 10f)
                    drawPath(crown, p.surface2)
                    drawPath(crown, p.accent, style = Stroke(0.7f))
                    brim(p.accent, 2f, 9f, 28f, 3f)
                    drawRect(p.warning, Offset(14f, 6f), Size(3f, 2f))
                }
                SeasonalDecoration.NONE -> Unit
            }
        }
    }
}

private fun DrawScope.brim(color: Color, x: Float, y: Float, width: Float, height: Float) =
    drawRoundRect(color, Offset(x, y), Size(width, height), CornerRadius(1f))
