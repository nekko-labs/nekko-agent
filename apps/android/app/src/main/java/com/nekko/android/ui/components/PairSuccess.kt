package com.nekko.android.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.simple.rememberReduceMotion
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Right after a pairing works: the phone and the computer link up, the cat pops
 * in cheering, and confetti bursts out from behind it. Drawn over the whole nav
 * host, because the first pairing swaps the welcome for the chat list
 * underneath. It goes after a few seconds, a tap or Back; with TalkBack on it
 * waits for *Let's go* (the recommended timeout is unlimited for controls).
 * The same screen as the iPhone's `PairSuccessView`.
 */
@Composable
fun PairSuccessOverlay(computerName: String?, onDone: () -> Unit) {
    val p = Nekko.palette
    val reduceMotion = rememberReduceMotion()
    val haptics = LocalHapticFeedback.current
    val a11y = LocalAccessibilityManager.current
    val linked = remember { Animatable(0f) }
    val cheer = remember { Animatable(0f) }
    var burst by remember { mutableStateOf(false) }

    BackHandler(onBack = onDone)
    LaunchedEffect(Unit) {
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        if (reduceMotion) {
            linked.snapTo(1f)
            cheer.snapTo(1f)
        } else {
            linked.animateTo(1f, tween(550, easing = FastOutSlowInEasing))
            launch { cheer.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = Spring.StiffnessMediumLow)) }
            burst = true
            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
        }
        val wait = a11y?.calculateRecommendedTimeoutMillis(3400, containsIcons = true, containsText = true, containsControls = true) ?: 3400L
        delay(wait)
        onDone()
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(p.paper.copy(alpha = 0.96f))
            // Takes every tap: nothing underneath is pressed by accident, and a tap anywhere closes it.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDone)
            .testTag("pairSuccess"),
        contentAlignment = Alignment.Center,
    ) {
        if (burst) ConfettiBurst(listOf(p.accent, p.success, p.warning, p.running, p.danger))
        Column(
            Modifier.widthIn(max = 520.dp).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(28.dp),
        ) {
            PairLinkIllustration(linked.value, cheer.value, reduceMotion)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    stringResource(R.string.chats_pair_success_title),
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = p.ink,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    computerName?.let { stringResource(R.string.chats_pair_success_named, it) }
                        ?: stringResource(R.string.chats_pair_success_body),
                    style = MaterialTheme.typography.bodyLarge,
                    color = p.inkSoft,
                    textAlign = TextAlign.Center,
                )
            }
            Button(
                onClick = onDone,
                modifier = Modifier.widthIn(max = 280.dp).fillMaxWidth().heightIn(min = 48.dp).testTag("pairSuccess.done"),
            ) { Text(stringResource(R.string.chats_pair_success_done)) }
        }
    }
}

/** The computer and the phone, a dotted line drawing between them, and the cat on it with a check badge. */
@Composable
private fun PairLinkIllustration(linked: Float, cheer: Float, reduceMotion: Boolean) {
    val p = Nekko.palette
    val description = stringResource(R.string.chats_pair_success_illustration)
    // A small happy hop, twice a second, once the cat is in.
    var t by remember { mutableFloatStateOf(0f) }
    if (!reduceMotion) {
        LaunchedEffect(Unit) {
            // An infinite animation: tests and the animation policy can pause it.
            val start = withInfiniteAnimationFrameNanos { it }
            while (true) t = (withInfiniteAnimationFrameNanos { it } - start) / 1e9f
        }
    }
    val hop = if (reduceMotion) 0f else -abs(sin(t * Math.PI.toFloat() * 2)) * 6f * cheer.coerceIn(0f, 1f)
    Row(Modifier.semantics(mergeDescendants = true) { contentDescription = description }, verticalAlignment = Alignment.CenterVertically) {
        DeviceTile(Icons.Outlined.Laptop, linked >= 1f)
        Box(Modifier.size(width = 128.dp, height = 96.dp), contentAlignment = Alignment.Center) {
            val accent = p.accent
            Canvas(Modifier.fillMaxWidth().height(3.dp)) {
                val startX = 6.dp.toPx()
                val endX = size.width - 6.dp.toPx()
                drawLine(
                    accent,
                    Offset(startX, size.height / 2),
                    Offset(startX + (endX - startX) * linked, size.height / 2),
                    strokeWidth = 3.dp.toPx(),
                    cap = StrokeCap.Round,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 8.dp.toPx())),
                )
            }
            Box(
                Modifier
                    .offset(y = hop.dp)
                    .scale(0.2f + 0.8f * cheer)
                    .alpha(cheer.coerceIn(0f, 1f))
                    .rotate(if (reduceMotion) 0f else -25f * (1f - cheer)),
            ) {
                PixelCat(Modifier.size(72.dp), happy = true)
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = p.success,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = 6.dp, y = 4.dp)
                        .size(26.dp)
                        .background(p.paper, CircleShape),
                )
            }
        }
        DeviceTile(Icons.Outlined.PhoneAndroid, linked >= 1f)
    }
}

@Composable
private fun DeviceTile(icon: androidx.compose.ui.graphics.vector.ImageVector, linked: Boolean) {
    val p = Nekko.palette
    val shape = RoundedCornerShape(18.dp)
    Box(
        Modifier
            .size(72.dp)
            .background(p.surface, shape)
            .border(if (linked) 2.dp else 1.dp, if (linked) p.accent else p.line, shape),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = null, tint = p.ink, modifier = Modifier.size(36.dp)) }
}

/**
 * Desktop's pixel cat face on its 32 x 32 grid, the iPhone's `PixelCat` drawn the same way:
 * brand plum, white line and eyes, light-plum mouth (spec/brand/colour-palette.md).
 */
@Composable
fun PixelCat(
    modifier: Modifier = Modifier,
    happy: Boolean = false,
    fill: Color = Color(0xFF190019),
    line: Color = Color.White,
) {
    Canvas(modifier) {
        val u = size.width / 32f
        val outline = Path().apply {
            CAT_FACE.forEachIndexed { i, (x, y) -> if (i == 0) moveTo(x * u, y * u) else lineTo(x * u, y * u) }
            close()
        }
        drawPath(outline, fill)
        drawPath(outline, line, style = Stroke(width = 2 * u, join = StrokeJoin.Miter))
        fun px(x: Int, y: Int, w: Int, h: Int, c: Color = line) = drawRect(c, Offset(x * u, y * u), Size(w * u, h * u))
        if (happy) {
            for (x in listOf(9, 19)) {
                px(x, 15, 1, 2)
                px(x + 1, 14, 2, 1)
                px(x + 3, 15, 1, 2)
            }
        } else {
            px(11, 15, 2, 3)
            px(20, 15, 2, 3)
        }
        px(15, 20, 2, 1, Color(0xFFC99BB3))
    }
}

private val CAT_FACE = listOf(
    4 to 5, 6 to 5, 6 to 7, 8 to 7, 8 to 9, 11 to 9, 11 to 10, 21 to 10, 21 to 9, 24 to 9, 24 to 7, 26 to 7, 26 to 5,
    28 to 5, 28 to 19, 27 to 19, 27 to 22, 25 to 22, 25 to 24, 22 to 24, 22 to 26, 10 to 26, 10 to 24, 7 to 24,
    7 to 22, 5 to 22, 5 to 19, 4 to 19,
)

/** One burst of confetti from just above the middle, gone in about three seconds. */
@Composable
private fun ConfettiBurst(colors: List<Color>) {
    var t by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) {
        val start = withFrameNanos { it }
        while (t < ConfettiPiece.LIFE + 0.2f) t = (withFrameNanos { it } - start) / 1e9f
    }
    Canvas(Modifier.fillMaxSize()) { drawConfetti(t, colors) }
}

private fun DrawScope.drawConfetti(t: Float, colors: List<Color>) {
    val origin = Offset(size.width / 2, size.height * 0.36f)
    val dp = density
    for ((i, piece) in ConfettiPiece.burst.withIndex()) {
        val pt = t - piece.delay
        if (pt <= 0f) continue
        // Thrown up and out, then gravity, with a little air drag on the sideways speed.
        val x = origin.x + dp * (piece.vx * pt * (1 - minOf(pt, 2.5f) * 0.18f) + sin(pt * piece.wobble) * 10f)
        val y = origin.y + dp * (piece.vy * pt + 0.5f * 980f * pt * pt)
        val fade = ((ConfettiPiece.LIFE - pt) / 0.6f).coerceIn(0f, 1f)
        if (fade <= 0f || y > size.height + 20 * dp) continue
        val color = colors[i % colors.size].copy(alpha = fade)
        val s = piece.size * dp
        translate(x, y) {
            rotate(Math.toDegrees((piece.spin * pt).toDouble()).toFloat(), Offset.Zero) {
                // Spinning paper: its width swings as it turns over.
                scale(cos(pt * piece.flip), 1f, Offset.Zero) {
                    if (piece.round) drawCircle(color, s / 2, Offset.Zero)
                    else drawRect(color, Offset(-s / 2, -s / 4), Size(s, s / 2))
                }
            }
        }
    }
}

/** One piece of confetti's throw, in dp and seconds; a fixed seed, so every burst looks the same. */
private class ConfettiPiece(
    val vx: Float, val vy: Float, val delay: Float, val spin: Float,
    val flip: Float, val wobble: Float, val size: Float, val round: Boolean,
) {
    companion object {
        /** Seconds a piece is on screen before it has faded out. */
        const val LIFE = 2.8f

        val burst: List<ConfettiPiece> = run {
            var seed = -0x61c8864680b583ebL // 0x9E3779B97F4A7C15, the iPhone's seed
            fun next(): Float {
                seed = seed * 6364136223846793005L + 1442695040888963407L
                return (seed ushr 11).toDouble().div((1L shl 53).toDouble()).toFloat()
            }
            List(56) {
                val angle = Math.toRadians(-90.0 + (next() - 0.5) * 130.0)
                val speed = 420f + next() * 380f
                ConfettiPiece(
                    vx = (cos(angle) * speed).toFloat(), vy = (sin(angle) * speed).toFloat(), delay = next() * 0.12f,
                    spin = (next() - 0.5f) * 14f, flip = 4f + next() * 8f, wobble = 3f + next() * 4f,
                    size = 7f + next() * 6f, round = next() < 0.25f,
                )
            }
        }
    }
}
