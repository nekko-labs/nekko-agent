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
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlin.math.cos
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

/** The same eight deterministic seeds and normalized geometry as iOS. */
internal object WinterFlakes {
    const val COUNT = 8
    const val CAT_INDEX = 3

    fun position(index: Int, seconds: Double): Offset {
        val seed = index.toDouble()
        return Offset(
            ((seed + 0.5) / COUNT + sin(seconds / 7 + seed) * 0.018).toFloat(),
            ((0.06 + seed * 0.113 + seconds / (24 + seed * 2)) % 1).toFloat(),
        )
    }

    fun snowflake() = Path().apply {
        repeat(6) { arm ->
            val angle = arm * Math.PI / 3
            fun point(radius: Double, offset: Double = 0.0) = Offset((cos(angle + offset) * radius).toFloat(), (sin(angle + offset) * radius).toFloat())
            moveTo(0f, 0f)
            point(1.0).let { lineTo(it.x, it.y) }
            for (offset in listOf(-0.45, 0.45)) {
                point(0.55).let { moveTo(it.x, it.y) }
                point(0.82, offset).let { lineTo(it.x, it.y) }
            }
        }
    }

    fun cat() = polygon(-0.85f to -0.85f, -0.35f to -0.35f, 0.35f to -0.35f, 0.85f to -0.85f,
        0.85f to 0.4f, 0.45f to 0.85f, -0.45f to 0.85f, -0.85f to 0.4f).apply {
        for (x in listOf(-0.3f, 0.3f)) { moveTo(x, 0f); lineTo(x, 0.2f) }
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
    val color = Nekko.palette.accent.copy(alpha = 0.24f)
    val snow = remember { WinterFlakes.snowflake() }
    val cat = remember { WinterFlakes.cat() }
    Canvas(modifier.clearAndSetSemantics { }) {
        val seconds = if (still) 0.0 else elapsed.doubleValue
        repeat(WinterFlakes.COUNT) { index ->
            val position = WinterFlakes.position(index, seconds)
            val radius = (if (index == WinterFlakes.CAT_INDEX) 6f else (3 + index % 3).toFloat()) * density
            translate(position.x * size.width, position.y * (size.height + 24 * density) - 12 * density) {
                scale(radius, radius, pivot = Offset.Zero) {
                    drawPath(if (index == WinterFlakes.CAT_INDEX) cat else snow, color,
                        style = Stroke(0.8f * density / radius, cap = StrokeCap.Round, join = StrokeJoin.Round))
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
