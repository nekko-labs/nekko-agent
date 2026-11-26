package com.nekko.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko

/**
 * A small sad Nekko (#2939, the iPhone's `SadNekko`): the secret-agent cat as a slender outline
 * with slim sunglasses, ears drooping, brows raised in the middle, a frown and one tear. Original
 * line art in the palette's ink, the same 64 × 64 drawing as the iPhone's. Still and decorative:
 * the words beside it say the same thing.
 */
@Composable
fun SadNekko(size: Dp = 56.dp, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Canvas(modifier.size(size).clearAndSetSemantics {}) {
        val k = this.size.width / 64f
        scale(k, k, pivot = Offset.Zero) {
            val line = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round)

            // Head and ears, one slender outline.
            val head = Path().apply {
                moveTo(14f, 36f)
                lineTo(12f, 10f)
                lineTo(27f, 21f)
                quadraticTo(32f, 19.5f, 37f, 21f)
                lineTo(52f, 10f)
                lineTo(50f, 36f)
                quadraticTo(52f, 54f, 32f, 55f)
                quadraticTo(12f, 54f, 14f, 36f)
            }
            drawPath(head, p.ink, style = line)

            // Slim sunglasses: two narrow lenses, a bridge and arms to the ears.
            listOf(17f, 34f).forEach { x -> drawRoundRect(p.ink, Offset(x, 30f), Size(13f, 6f), CornerRadius(3f, 3f)) }
            drawLine(p.ink, Offset(30f, 32f), Offset(34f, 32f), 2f, StrokeCap.Round)
            drawLine(p.ink, Offset(17f, 32f), Offset(13.5f, 31f), 2f, StrokeCap.Round)
            drawLine(p.ink, Offset(47f, 32f), Offset(50.5f, 31f), 2f, StrokeCap.Round)

            // Sad brows: low at the outside, raised in the middle.
            drawLine(p.inkSoft, Offset(17f, 28f), Offset(28f, 25f), 2f, StrokeCap.Round)
            drawLine(p.inkSoft, Offset(47f, 28f), Offset(36f, 25f), 2f, StrokeCap.Round)

            // Nose, a frown, and whiskers drooping outward.
            drawOval(p.ink, Offset(30.8f, 39.5f), Size(2.4f, 1.8f))
            drawPath(Path().apply { moveTo(26.5f, 49f); quadraticTo(32f, 43.5f, 37.5f, 49f) }, p.ink, style = line)
            listOf(
                Offset(13f, 42f) to Offset(5f, 43.5f),
                Offset(13.5f, 46f) to Offset(6.5f, 50f),
                Offset(51f, 42f) to Offset(59f, 43.5f),
                Offset(50.5f, 46f) to Offset(57.5f, 50f),
            ).forEach { (a, b) -> drawLine(p.inkSoft, a, b, 1.4f, StrokeCap.Round) }

            // One tear under the right lens.
            val tear = Path().apply {
                moveTo(43f, 38.5f)
                quadraticTo(40.5f, 42.5f, 43f, 45f)
                quadraticTo(45.5f, 42.5f, 43f, 38.5f)
            }
            drawPath(tear, p.running)
        }
    }
}
