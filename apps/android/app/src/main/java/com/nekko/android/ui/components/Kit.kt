package com.nekko.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nekko.android.ui.theme.Nekko

/** Status hues used by dots, pills and notices. */
enum class Tone { SUCCESS, WARNING, DANGER, ACCENT, FAINT }

@Composable
fun toneColor(t: Tone): Color {
    val p = Nekko.palette
    return when (t) {
        Tone.SUCCESS -> p.success
        Tone.WARNING -> p.warning
        Tone.DANGER -> p.danger
        Tone.ACCENT -> p.accent
        Tone.FAINT -> p.inkFaint
    }
}

@Composable
fun toneSoft(t: Tone): Color {
    val p = Nekko.palette
    return when (t) {
        Tone.SUCCESS -> p.successSoft
        Tone.WARNING -> p.warningSoft
        Tone.DANGER -> p.dangerSoft
        Tone.ACCENT -> p.accentSoft
        Tone.FAINT -> p.surface2
    }
}

@Composable
fun Dot(tone: Tone, modifier: Modifier = Modifier) {
    Box(modifier.size(8.dp).clip(CircleShape).background(toneColor(tone)))
}

@Composable
fun Pill(label: String, tone: Tone, icon: ImageVector? = null) {
    Row(
        Modifier.clip(RoundedCornerShape(999.dp)).background(toneSoft(tone)).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = toneColor(tone), modifier = Modifier.size(12.dp))
        Text(label, color = toneColor(tone), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** A bordered surface card, the Expo kit's `Card`. */
@Composable
fun NCard(modifier: Modifier = Modifier, border: Color? = null, content: @Composable ColumnScope.() -> Unit) {
    val p = Nekko.palette
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(p.surface)
            .border(1.dp, border ?: p.line, RoundedCornerShape(16.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun SectionHeader(title: String) {
    Text(
        title.uppercase(),
        style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
        color = Nekko.palette.inkFaint,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.6.sp,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 8.dp),
    )
}

/** A soft-coloured notice line (errors, warnings). */
@Composable
fun Notice(text: String, tone: Tone, modifier: Modifier = Modifier) {
    Text(
        text,
        color = toneColor(tone),
        style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(toneSoft(tone))
            .padding(12.dp),
    )
}
