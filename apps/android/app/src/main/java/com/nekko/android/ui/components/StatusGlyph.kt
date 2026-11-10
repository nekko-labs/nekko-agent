package com.nekko.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Our agent status glyphs (docs/design-system.md, Agent status), the shapes of the
 * desktop's `StatusIcon` and the iPhone's `LiveStatusGlyph.swift`, drawn as lines so
 * colour is never the only cue. Never a Material icon.
 */
enum class StatusGlyph(internal val grid: Float, pathData: String) {
    /** Working: the desktop's line rocket, nose up, on its 24 grid. */
    ROCKET(
        24f,
        "M12 2.5C14.6 4.5 15.8 7.5 15.8 11.1L15.8 16L8.2 16L8.2 11.1C8.2 7.5 9.4 4.5 12 2.5Z" +
            "M13.6 9.5A1.6 1.6 0 1 1 10.4 9.5A1.6 1.6 0 1 1 13.6 9.5Z" +
            "M8.2 12.5L5.8 15L5.8 17.2L8.2 16M15.8 12.5L18.2 15L18.2 17.2L15.8 16M10.6 18.2L12 21.5L13.4 18.2",
    ),

    /** Needs you. */
    QUESTION(18f, "M5.5 6Q5.5 2.5 9 2.5Q12.5 2.5 12.5 6Q12.5 8.5 9 10L9 11.5M9.9 15A0.9 0.9 0 1 1 8.1 15A0.9 0.9 0 1 1 9.9 15Z"),

    /** Stopped on an error. */
    WARNING(18f, "M9 2.5L16.5 15.5L1.5 15.5ZM9 7L9 10.5M9.6 13.2A0.6 0.6 0 1 1 8.4 13.2A0.6 0.6 0 1 1 9.6 13.2Z"),

    /** Prompts waiting to send. */
    CLOCK(18f, "M16 9A7 7 0 1 1 2 9A7 7 0 1 1 16 9ZM9 5L9 9L12 10.5"),

    /** Watching: Zz. */
    SLEEP(18f, "M2 8L9 8L2 15.5L9 15.5M11 2.5L16 2.5L11 8L16 8"),

    /** Done. */
    CHECK(18f, "M3.5 9.5L7.5 13.5L14.5 4.5"),
    ;

    internal val path: Path by lazy { PathParser().parsePathString(pathData).toPath() }
}

/** [glyph] as a [size] square line drawing in [color], 1.5dp strokes as on the desktop. */
@Composable
fun StatusGlyphIcon(glyph: StatusGlyph, color: Color, modifier: Modifier = Modifier, size: Dp = 18.dp) {
    Canvas(modifier.size(size)) {
        val k = this.size.width / glyph.grid
        scale(k, pivot = Offset.Zero) {
            drawPath(glyph.path, color, style = Stroke(width = 1.5.dp.toPx() / k, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}
