package com.nekko.android.lock

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The opening animation, the iPhone's (apps/ios/App/Views/Splash.swift, #1836, #1905) and the
 * desktop's (splash.ts): on the brand plum the cat builds up from pixels on the beat from the
 * first frame, holds until the app may open (here: unlocked), then zooms towards the viewer
 * while the inside of the cat opens as a window onto the app, until the app fills the screen.
 * About a second in all. Drawn from elapsed time in one Canvas, from the same generated layers
 * ([SplashCells]). With animations off the plum and the finished cat simply fade.
 */
object Splash {
    /** The brand plum, the app icon's tile: `#190019`. */
    val GROUND = Color(0xFF190019)
    /** The cat's line on plum: white, as on the app icon. */
    val INK = Color.White

    /** One beat, in seconds: the desktop's beats, quicker, so build and zoom take about a second. */
    const val B = 0.28f
    const val ZOOM_AT = 2.5f * B
    const val ZOOM_FOR = 1.05f * B
    /**
     * The opening has played in this process: a cold launch plays it once (unlocked, it builds
     * and zooms straight in); rotating or recreating the activity does not play it again.
     * Each time the app locks it plays again, waiting for the unlock. Under instrumentation the
     * launch opening is skipped (the iPhone's `-splash NO`), so app tests start on the app; the
     * lock's opening still plays.
     */
    @Volatile var launched = runCatching { Class.forName("androidx.test.platform.app.InstrumentationRegistry") }.isSuccess

    /** The longest step a drawn frame may take: a stalled start slows the build rather than skipping it. */
    const val MAX_STEP = 1f / 30f

    internal val head: Path by lazy { PathParser().parsePathString(SplashCells.BRAND_HEAD).toPath().apply { fillType = PathFillType.EvenOdd } }
    /** The window inside the cat: the head's second subpath. */
    internal val inner: Path by lazy { PathParser().parsePathString(SplashCells.BRAND_HEAD.substringAfter("Z")).toPath() }
    private val mid: Path by lazy { PathParser().parsePathString(SplashCells.MID_PATH).toPath() }
    private val fine: Path by lazy { PathParser().parsePathString(SplashCells.FINE_PATH).toPath() }

    /** The clock after a frame [dt] seconds later: never past [limit], never more than [MAX_STEP] a frame. */
    fun advance(t: Float, dt: Float, limit: Float): Float = min(limit, t + dt.coerceIn(0f, MAX_STEP))

    /** Where the clock holds: the finished cat until [ready], then the end of the zoom. */
    fun limit(ready: Boolean): Float = if (ready) ZOOM_AT + ZOOM_FOR else ZOOM_AT

    /** A small wind-up, then steady exponential growth through the cat. */
    fun zoomScale(t: Float, reach: Float): Float {
        val p = (t - ZOOM_AT) / ZOOM_FOR
        if (p <= 0f) return 1f
        if (p < 0.25f) return 1f - 0.07f * Ease.windUp(p / 0.25f)
        return 0.93f * (reach / 0.93f).pow(min(1f, (p - 0.25f) / 0.75f).pow(1.35f))
    }

    /** The frame at [t] seconds. The cat is small and central, a little under a tenth of the screen, at least [minSide] px. */
    internal fun DrawScope.draw(t: Float, minSide: Float) {
        val (w, h) = size
        val k = max(minSide, max(w, h) * 0.085f) / 20f
        val ox = w / 2 - 12 * k
        val oy = h / 2 - 9 * k
        val z = zoomScale(t, reach = hypot(w, h) / (8 * k) * 1.6f)
        withTransform({
            translate(ox, oy)
            scale(k, k, pivot = Offset.Zero)
            // The zoom grows from the cat's middle.
            scale(z, z, pivot = Offset(12f, 10.6f))
        }) {
            // The ground, with the cat's window cut out of it (the app shows through once the lid lifts).
            val ground = Path().apply {
                addRect(Rect(-4000f, -4000f, 4000f, 4000f))
                addPath(inner)
                fillType = PathFillType.EvenOdd
            }
            drawPath(ground, GROUND)
            // The lid keeps the window shut until the zoom.
            val lid = 1f - Ease.inOut(((t - ZOOM_AT - 0.05f * ZOOM_FOR) / (0.35f * ZOOM_FOR)).coerceIn(0f, 1f))
            if (lid > 0f) {
                drawPath(inner, GROUND, alpha = lid)
                drawPath(inner, GROUND, alpha = lid, style = Stroke(width = 0.2f))
            }
            // A small settle each time the resolution steps up.
            var pulse = 1f
            for (at in listOf(B, 1.5f * B, 2 * B)) if (t >= at && t < at + 0.22f * B) pulse = 0.988f + 0.012f * Ease.out((t - at) / (0.22f * B))
            withTransform({ scale(pulse, pulse, pivot = Offset(12f, 9f)) }) {
                when {
                    t < B -> {
                        // Beat 1: chunky pixels pop in left to right.
                        val s = SplashCells.CHUNKY_SIZE
                        val cells = SplashCells.CHUNKY_CELLS
                        for (i in cells.indices step 2) {
                            val x = cells[i]
                            val y = cells[i + 1]
                            val p = Ease.out(((t - (x - 2) / 19 * 0.6f * B) / (0.3f * B)).coerceIn(0f, 1f))
                            if (p <= 0f) continue
                            val side = (s - 0.14f) * p
                            drawRect(INK, Offset(x + s / 2 - side / 2, y + s / 2 - side / 2), Size(side, side))
                        }
                    }
                    t < 1.5f * B -> drawPath(mid, INK)
                    t < 2 * B -> drawPath(fine, INK)
                    else -> {
                        drawPath(head, INK)
                        drawPath(head, INK, style = Stroke(width = 0.5f, join = StrokeJoin.Miter, miter = 8f))
                    }
                }
            }
        }
    }
}

/**
 * The opening over the app: builds the cat from its first frame and holds it until [ready],
 * then zooms into the app and calls [onDone]. [onBuilt] says once the cat is whole. [still]
 * (animations off) shows the finished cat at once and fades it all once ready. It takes no touches and says nothing to TalkBack: the screen
 * it covers does that.
 */
@Composable
fun PixelOpening(ready: Boolean, still: Boolean, onDone: () -> Unit, modifier: Modifier = Modifier, onBuilt: () -> Unit = {}) {
    val done by rememberUpdatedState(onDone)
    val built by rememberUpdatedState(onBuilt)
    if (still) {
        var faded by remember { mutableStateOf(false) }
        val alpha by animateFloatAsState(if (faded) 0f else 1f, tween(250), label = "opening-fade")
        LaunchedEffect(Unit) { built() }
        LaunchedEffect(ready) {
            if (!ready) return@LaunchedEffect
            faded = true
            delay(260)
            done()
        }
        Canvas(modifier.fillMaxSize().graphicsLayer { this.alpha = alpha }) { with(Splash) { draw(Splash.ZOOM_AT, 40.dp.toPx()) } }
        return
    }
    var t by remember { mutableFloatStateOf(0f) }
    val isReady by rememberUpdatedState(ready)
    LaunchedEffect(Unit) {
        var last = -1L
        var told = false
        while (true) {
            val limit = Splash.limit(isReady)
            // The cat is whole: the lock screen may now ask for the fingerprint over it.
            if (!told && t >= Splash.ZOOM_AT) { told = true; built() }
            if (t >= limit) {
                if (isReady) { done(); return@LaunchedEffect }
                // Built and still waiting (on the fingerprint): no redraws until it may open.
                last = -1L
                delay(16)
                continue
            }
            withFrameNanos { now ->
                if (last >= 0) t = Splash.advance(t, (now - last) / 1e9f, limit)
                last = now
            }
        }
    }
    Canvas(modifier.fillMaxSize()) { with(Splash) { draw(t, 40.dp.toPx()) } }
}

/** The desktop's CSS cubic-bezier curves. */
object Ease {
    fun out(x: Float) = bezier(0.2f, 0.8f, 0.2f, 1f, x)
    fun inOut(x: Float) = bezier(0.4f, 0f, 0.6f, 1f, x)
    fun windUp(x: Float) = bezier(0.3f, 0f, 0.5f, 1f, x)

    /** `cubic-bezier(x1, y1, x2, y2)` at progress [x]: solve for the curve's t by bisection, return its y. */
    fun bezier(x1: Float, y1: Float, x2: Float, y2: Float, x: Float): Float {
        val p = x.coerceIn(0f, 1f)
        fun at(a: Float, b: Float, t: Float) = 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t
        var lo = 0f
        var hi = 1f
        repeat(30) {
            val m = (lo + hi) / 2
            if (at(x1, x2, m) < p) lo = m else hi = m
        }
        return at(y1, y2, (lo + hi) / 2)
    }
}
