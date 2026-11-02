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
import androidx.compose.ui.graphics.luminance
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
    inkFaint = Color(0xFF6A6A76),
    accent = Color(0xFF5A4AE8),
    accentInk = Color(0xFFFFFFFF),
    accentSoft = Color(0x215A4AE8),
    success = Color(0xFF1E7A4A),
    successSoft = Color(0x241E7A4A),
    danger = Color(0xFFB42318),
    dangerSoft = Color(0x24B42318),
    warning = Color(0xFF8F5C0A),
    warningSoft = Color(0x248F5C0A),
    running = Color(0xFF1D4ED8),
    userBubble = Color(0xFF5A4AE8),
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
    inkFaint = Color(0xFF8E8E9B),
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

/**
 * The palette with the computer's accent in place of Nekko's indigo: the
 * accent, its soft tint, the text drawn on it (dark or white, whichever reads
 * better) and, in light mode, the user's bubble, as the desktop paints them.
 */
fun Palette.withAccent(argb: Long?, dark: Boolean): Palette {
    if (argb == null) return this
    val a = Color(argb)
    val onAccent = if (contrast(a, Color.White) >= contrast(a, Color(0xFF0C0C11))) Color.White else Color(0xFF0C0C11)
    return copy(
        accent = a,
        accentInk = onAccent,
        accentSoft = a.copy(alpha = if (dark) 0.18f else 0.13f),
        userBubble = if (dark) userBubble else a,
        userInk = if (dark) userInk else onAccent,
    )
}

/**
 * A desktop preset over the palette (the iPhone's `Palette.make`): its accent
 * when the computer sends none (System, Light and Dark keep Nekko's), and, in
 * the mode it was drawn for, its paper, surfaces, ink and line.
 */
fun Palette.withPreset(preset: ThemePreset?, accent: Long?, dark: Boolean): Palette {
    var p = withAccent(accent ?: preset?.takeIf { !it.isBasic }?.accent, dark)
    // A preset's surfaces only fit the mode it was drawn for.
    if (preset == null || (preset.mode == ThemePreset.Mode.DARK) != dark) return p
    fun c(v: Long?, old: Color) = v?.let { Color(it) } ?: old
    p = p.copy(
        paper = c(preset.paper, p.paper),
        surface = c(preset.surface, p.surface),
        surface2 = c(preset.surface2, p.surface2),
        ink = c(preset.ink, p.ink),
        inkSoft = c(preset.inkSoft, p.inkSoft),
        inkFaint = c(preset.inkFaint, p.inkFaint),
        line = c(preset.line, p.line),
    )
    return if (dark) p.copy(userInk = c(preset.ink, p.userInk)) else p
}

/** WCAG 2 contrast ratio between two colours (1..21). */
fun contrast(a: Color, b: Color): Float {
    val (x, y) = a.luminance() to b.luminance()
    return (maxOf(x, y) + 0.05f) / (minOf(x, y) + 0.05f)
}

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
fun NekkoTheme(dark: Boolean = isSystemInDarkTheme(), accent: Long? = null, preset: ThemePreset? = null, content: @Composable () -> Unit) {
    val p = (if (dark) DarkPalette else LightPalette).withPreset(preset, accent, dark)
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
