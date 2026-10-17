package com.nekko.android.ui.chat

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Markdown
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * An agent reply as Markdown (AN-8), the same subset as the iPhone app's
 * `MarkdownText`: code blocks that scroll sideways with a Copy button,
 * headings, lists, quotes, rules and inline bold, italic, code and links.
 * Links open in the browser only when tapped; images are never loaded.
 */
@Composable
fun MarkdownText(text: String, color: Color, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val pieces = remember(text) { Markdown.parse(text) }
    val body = MaterialTheme.typography.bodyLarge.copy(color = color)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (piece in pieces) {
            when (piece) {
                is Markdown.Piece.Code -> CodeBlock(piece.language, piece.code)
                is Markdown.Piece.Heading -> Text(
                    inline(piece.text),
                    style = when {
                        piece.level <= 1 -> MaterialTheme.typography.titleLarge
                        piece.level == 2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }.copy(color = color, fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.semantics { heading() },
                )
                is Markdown.Piece.Bullet -> Row(
                    Modifier.padding(start = (piece.indent * 14).dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(piece.marker, style = body.copy(color = p.inkSoft))
                    Text(inline(piece.text), style = body)
                }
                is Markdown.Piece.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(p.line))
                    Text(inline(piece.text), style = body.copy(color = p.inkSoft), modifier = Modifier.padding(start = 10.dp))
                }
                Markdown.Piece.Rule -> HorizontalDivider(color = p.line)
                is Markdown.Piece.Paragraph -> Text(inline(piece.text), style = body)
            }
        }
    }
}

@Composable
private fun inline(s: String): AnnotatedString {
    val p = Nekko.palette
    val links = TextLinkStyles(SpanStyle(color = p.accent, textDecoration = TextDecoration.Underline))
    return remember(s, p) {
        buildAnnotatedString {
            for (span in Markdown.inline(s)) {
                val style = SpanStyle(
                    fontWeight = if (Markdown.Style.BOLD in span.styles) FontWeight.SemiBold else null,
                    fontStyle = if (Markdown.Style.ITALIC in span.styles) FontStyle.Italic else null,
                    fontFamily = if (Markdown.Style.CODE in span.styles) FontFamily.Monospace else null,
                    background = if (Markdown.Style.CODE in span.styles) p.code else Color.Unspecified,
                )
                val url = span.url
                if (url != null && safeLink(url)) {
                    withLink(LinkAnnotation.Url(url, links)) { withStyle(style) { append(span.text) } }
                } else {
                    withStyle(style) { append(span.text) }
                }
            }
        }
    }
}

/** Only web and mail links are tappable; anything else (intent:, file:, javascript:) stays text. */
internal fun safeLink(url: String): Boolean {
    val scheme = url.substringBefore(':', "").lowercase()
    return scheme == "https" || scheme == "http" || scheme == "mailto"
}

@Composable
private fun CodeBlock(language: String, code: String) {
    val p = Nekko.palette
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1200)
            copied = false
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(p.code)
            .border(1.dp, p.line, RoundedCornerShape(10.dp)),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                language.ifEmpty { "code" },
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = p.inkSoft,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Code", code))) }
                copied = true
            }) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                    contentDescription = if (copied) "Copied" else "Copy code",
                    tint = p.inkSoft,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Text(
            code,
            style = Nekko.mono.merge(TextStyle(color = p.ink)),
            softWrap = false,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
        )
    }
}
