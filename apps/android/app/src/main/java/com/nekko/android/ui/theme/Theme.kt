package com.nekko.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Nekko Agent's palette, carried over from `apps/mobile/src/ui/theme.ts` (which
 * mirrors the desktop's tokens) so the phone reads as the same product.
 */
@Immutable
data class Palette(
    val paper: Color,
    val surface: Color,
    val surface2: Color,
    val line: Color,
    val ink: Color,
    val inkSoft: Color,
    val inkFaint: Color,
    val accent: Color,
    val accentInk: Color,
    val accentSoft: Color,
    val success: Color,
    val successSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
    val warning: Color,
    val warningSoft: Color,
    val running: Color,
    val userBubble: Color,
    val userInk: Color,
    val code: Color,
)

val LightPalette = Palette(
    paper = Color(0xFFFBFBFD),
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFF2F2F7),
    line = Color(0xFFE8E8EF),
    ink = Color(0xFF17171D),
    inkSoft = Color(0xFF52525E),
    inkFaint = Color(0xFF8A8A97),
    accent = Color(0xFF6D5EFC),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x216D5EFC),
    success = Color(0xFF3AA870),
    successSoft = Color(0x243AA870),
    danger = Color(0xFFD24738),
    dangerSoft = Color(0x24D24738),
    warning = Color(0xFFC9871F),
    warningSoft = Color(0x24C9871F),
    running = Color(0xFF3B82F6),
    userBubble = Color(0xFF6D5EFC),
    userInk = Color(0xFFFFFFFF),
    code = Color(0xFFF2F2F7),
)

val DarkPalette = Palette(
    paper = Color(0xFF0C0C11),
    surface = Color(0xFF16161C),
    surface2 = Color(0xFF20202A),
    line = Color(0xFF26262F),
    ink = Color(0xFFECEAF3),
    inkSoft = Color(0xFFA3A1B0),
    inkFaint = Color(0xFF6B6B78),
    accent = Color(0xFF8B7DFF),
    accentInk = Color(0xFF0C0C11),
    accentSoft = Color(0x2E8B7DFF),
    success = Color(0xFF4CC38A),
    successSoft = Color(0x294CC38A),
    danger = Color(0xFFEF6A5B),
    dangerSoft = Color(0x29EF6A5B),
    warning = Color(0xFFE3A446),
    warningSoft = Color(0x29E3A446),
    running = Color(0xFF60A5FA),
    userBubble = Color(0xFF2A2550),
    userInk = Color(0xFFECEAF3),
    code = Color(0xFF101016),
)

private val LocalPalette = staticCompositionLocalOf { DarkPalette }

object Nekko {
    val palette: Palette
        @Composable @ReadOnlyComposable get() = LocalPalette.current

    val mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 18.sp)
}

private val typography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontSize = 28.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp),
        titleMedium = t.titleMedium.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = t.bodyLarge.copy(fontSize = 16.sp, lineHeight = 23.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 14.sp, lineHeight = 19.sp),
        bodySmall = t.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
    )
}

/** Material 3 with the Nekko palette; dynamic color is deliberately off. */
@Composable
fun NekkoTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val p = if (dark) DarkPalette else LightPalette
    val scheme = if (dark) {
        darkColorScheme(
            primary = p.accent, onPrimary = p.accentInk, primaryContainer = p.accentSoft, onPrimaryContainer = p.ink,
            secondary = p.accent, onSecondary = p.accentInk, secondaryContainer = p.surface2, onSecondaryContainer = p.ink,
            background = p.paper, onBackground = p.ink, surface = p.paper, onSurface = p.ink,
            surfaceVariant = p.surface2, onSurfaceVariant = p.inkSoft, surfaceContainer = p.surface,
            surfaceContainerLow = p.surface, surfaceContainerHigh = p.surface2, surfaceContainerHighest = p.surface2,
            surfaceContainerLowest = p.paper,
            outline = p.inkFaint, outlineVariant = p.line, error = p.danger, onError = p.accentInk,
            errorContainer = p.dangerSoft, onErrorContainer = p.danger,
        )
    } else {
        lightColorScheme(
            primary = p.accent, onPrimary = p.accentInk, primaryContainer = p.accentSoft, onPrimaryContainer = p.ink,
            secondary = p.accent, onSecondary = p.accentInk, secondaryContainer = p.surface2, onSecondaryContainer = p.ink,
            background = p.paper, onBackground = p.ink, surface = p.paper, onSurface = p.ink,
            surfaceVariant = p.surface2, onSurfaceVariant = p.inkSoft, surfaceContainer = p.surface,
            surfaceContainerLow = p.surface, surfaceContainerHigh = p.surface2, surfaceContainerHighest = p.surface2,
            surfaceContainerLowest = p.surface,
            outline = p.inkFaint, outlineVariant = p.line, error = p.danger, onError = p.accentInk,
            errorContainer = p.dangerSoft, onErrorContainer = p.danger,
        )
    }
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
