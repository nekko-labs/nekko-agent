package com.nekko.android.ui.chat

import android.content.ClipData
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import com.nekko.android.previews.ChatPreviews
import com.nekko.android.previews.LocalChatPreviews
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ChatLinks
import com.nekko.protocol.ChatPreviewLink
import com.nekko.protocol.Markdown
import com.nekko.protocol.MarkdownBlock
import com.nekko.protocol.MarkdownList
import com.nekko.protocol.MarkdownListItem
import com.nekko.protocol.MarkdownParser
import com.nekko.protocol.MarkdownTable
import com.nekko.protocol.MermaidRules
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Chat Markdown (MD-6, the iPhone's MD-2 `MarkdownText`): the block tree from
 * `MarkdownParser`, drawn natively. Fenced code (scrollable, copyable),
 * headings, real nested lists with markers by depth and task checkboxes,
 * table grids (sideways scroll, Expand, copy actions), quotes, rules, and
 * inline bold, italic, strikethrough, code and links. Links open only when
 * tapped (a file or a loopback page in the preview window, AN-35); images are
 * never loaded. [bubble] draws it inside the user's own bubble, in its ink.
 */
@Composable
fun MarkdownText(text: String, color: Color, modifier: Modifier = Modifier, bubble: Boolean = false) {
    val p = Nekko.palette
    // In a chat, links to files and loopback pages open previews (AN-35); paths Markdown can't read as links are made into file: URLs first.
    val previews = LocalChatPreviews.current
    val blocks = remember(text, previews != null) { MarkdownParser.blocks(if (previews != null) ChatLinks.linkable(text) else text) }
    val cards = remember(text, previews != null) { if (previews != null) ChatLinks.previews(text) else emptyList() }
    val style = if (bubble) MarkdownStyle.bubble(color) else MarkdownStyle.standard(color)
    Blocks(blocks, style, previews, cards, modifier)
}

/** The colours a Markdown body draws with. */
internal data class MarkdownStyle(
    val ink: Color,
    val soft: Color,
    val faint: Color,
    val line: Color,
    val codeFill: Color,
    val codeInk: Color,
    val headerFill: Color,
    val done: Color,
    val link: Color,
) {
    companion object {
        @Composable
        fun standard(ink: Color): MarkdownStyle {
            val p = Nekko.palette
            return MarkdownStyle(ink, p.inkSoft, p.inkFaint, p.line, p.code, p.ink, p.code, p.success, p.accent)
        }

        /** On the accent-coloured bubble every tint is the bubble's own ink, faded. */
        fun bubble(ink: Color) = MarkdownStyle(
            ink, ink.copy(alpha = 0.85f), ink.copy(alpha = 0.7f), ink.copy(alpha = 0.35f), Color.Black.copy(alpha = 0.18f), ink,
            ink.copy(alpha = 0.14f), ink, ink,
        )
    }
}

@Composable
private fun Blocks(blocks: List<MarkdownBlock>, style: MarkdownStyle, previews: ChatPreviews?, cards: List<ChatPreviewLink>, modifier: Modifier = Modifier) {
    val body = MaterialTheme.typography.bodyLarge.copy(color = style.ink)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) {
            when (block) {
                is MarkdownBlock.Code ->
                    if (MermaidRules.isMermaid(block.language)) MermaidBlock(block.body, block.closed, style)
                    else CodeBlock(block.language, block.body, style)
                is MarkdownBlock.Heading -> Text(
                    inline(block.text, style, previews, cards),
                    style = when {
                        block.level <= 1 -> MaterialTheme.typography.titleLarge
                        block.level == 2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }.copy(color = style.ink, fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.semantics { heading() },
                )
                is MarkdownBlock.ListBlock -> ListView(block.list, 0, style, previews, cards)
                is MarkdownBlock.Table -> TableView(block.table, style, previews, cards)
                is MarkdownBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(style.line))
                    Blocks(block.blocks, style.copy(ink = style.soft), previews, cards, Modifier.padding(start = 10.dp))
                }
                MarkdownBlock.Rule -> HorizontalDivider(color = style.line)
                is MarkdownBlock.Paragraph -> Text(inline(block.text, style, previews, cards), style = body)
            }
        }
    }
}

// ---- lists ----

/** A list as a tree: the marker on the first line, the item's text and its nested lists hanging beside it. */
@Composable
private fun ListView(list: MarkdownList, depth: Int, style: MarkdownStyle, previews: ChatPreviews?, cards: List<ChatPreviewLink>) {
    val body = MaterialTheme.typography.bodyLarge.copy(color = style.ink)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        list.items.forEachIndexed { i, item ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Marker(list, depth, list.start + i, item, style)
                Column(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (item.text.isNotEmpty() || item.children.isEmpty()) {
                        Text(
                            inline(item.text, style, previews, cards),
                            style = if (item.task == MarkdownListItem.Task.DONE) body.copy(color = style.ink.copy(alpha = 0.7f)) else body,
                        )
                    }
                    item.children.forEach { ListView(it, depth + 1, style, previews, cards) }
                }
            }
        }
    }
}

@Composable
private fun Marker(list: MarkdownList, depth: Int, number: Int, item: MarkdownListItem, style: MarkdownStyle) {
    val task = item.task
    if (task != null) {
        val done = task == MarkdownListItem.Task.DONE
        Icon(
            if (done) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
            contentDescription = if (done) "Done" else "Not done",
            tint = if (done) style.done else style.faint,
            modifier = Modifier.padding(top = 3.dp).size(18.dp),
        )
    } else {
        // Numbers line up on their dots; bullets get a narrow column. A bullet says nothing to TalkBack.
        Text(
            MarkdownParser.marker(list.ordered, depth, number),
            style = MaterialTheme.typography.bodyLarge.copy(color = style.soft, fontFeatureSettings = "tnum"),
            textAlign = if (list.ordered) TextAlign.End else TextAlign.Center,
            modifier = Modifier.widthIn(min = if (list.ordered) 18.dp else 10.dp).then(
                if (list.ordered) Modifier else Modifier.clearAndSetSemantics {},
            ),
        )
    }
}

// ---- tables ----

/**
 * A pipe table as a grid: bold header on a faint fill, hairlines between
 * rows, columns aligned as the `:---:` markers say. It scrolls sideways
 * inside its own frame; a long press offers Copy as Markdown, Copy as text
 * and Share, and a big one also offers Expand.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TableView(table: MarkdownTable, style: MarkdownStyle, previews: ChatPreviews?, cards: List<ChatPreviewLink>) {
    var menu by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    val actions = rememberTableActions(table)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box {
            Box(
                Modifier.horizontalScroll(rememberScrollState())
                    .combinedClickable(onClick = {}, onLongClick = { menu = true }, onLongClickLabel = "Table actions")
                    .testTag("markdown.table"),
            ) {
                TableGrid(
                    table, style, previews, cards, cellCap = 240.dp,
                    modifier = Modifier.padding(1.dp).clip(RoundedCornerShape(8.dp)).border(1.dp, style.line, RoundedCornerShape(8.dp)),
                )
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) { TableActionItems(actions) { menu = false } }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (table.isLarge) {
                TextButton(onClick = { expanded = true }, modifier = Modifier.testTag("markdown.table.expand")) {
                    Icon(Icons.Filled.OpenInFull, contentDescription = null, tint = style.soft, modifier = Modifier.size(16.dp))
                    Text("Expand", style = MaterialTheme.typography.labelMedium, color = style.soft, modifier = Modifier.padding(start = 6.dp))
                }
            }
            actions.note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = style.faint, modifier = Modifier.padding(start = 8.dp)) }
        }
    }
    if (expanded) TableScreen(table, previews, cards) { expanded = false }
}

/** Copy as Markdown, Copy as text and Share, with a short note after a copy. */
private class TableActions(val markdown: () -> Unit, val text: () -> Unit, val share: () -> Unit) {
    var note by mutableStateOf<String?>(null)
}

@Composable
private fun rememberTableActions(table: MarkdownTable): TableActions {
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    lateinit var actions: TableActions
    fun copy(s: String, note: String) {
        scope.launch {
            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Table", s)))
            actions.note = note
            delay(1500)
            actions.note = null
        }
    }
    actions = remember(table) {
        TableActions(
            markdown = { copy(table.markdown, "Copied as Markdown") },
            text = { copy(table.tabSeparated, "Copied as text") },
            share = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, table.markdown)
                context.startActivity(Intent.createChooser(send, null))
            },
        )
    }
    return actions
}

@Composable
private fun TableActionItems(actions: TableActions, done: () -> Unit) {
    DropdownMenuItem(text = { Text("Copy as Markdown") }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) }, onClick = { done(); actions.markdown() })
    DropdownMenuItem(text = { Text("Copy as text") }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) }, onClick = { done(); actions.text() })
    DropdownMenuItem(text = { Text("Share") }, leadingIcon = { Icon(Icons.Filled.Share, null) }, onClick = { done(); actions.share() })
}

/**
 * The grid itself: each column as wide as its widest cell, but no wider than
 * [cellCap] (where long cells wrap); each row as tall as its tallest cell.
 * TalkBack hears it as rows: "Row 2 of 5: Name, Nekko; Status, done".
 */
@Composable
private fun TableGrid(table: MarkdownTable, style: MarkdownStyle, previews: ChatPreviews?, cards: List<ChatPreviewLink>, cellCap: Dp, modifier: Modifier = Modifier) {
    val columns = table.header.size
    val text = MaterialTheme.typography.bodyMedium.copy(color = style.ink)
    val spoken = remember(table) {
        "Table, $columns columns, ${table.rows.size} rows. " + table.rows.indices.joinToString(". ") { table.accessibilityRow(it) }
    }
    Layout(
        content = {
            (listOf(table.header) + table.rows).forEachIndexed { r, row ->
                row.forEachIndexed { col, cell ->
                    val align = when (table.alignments.getOrNull(col)) {
                        MarkdownTable.Alignment.CENTER -> TextAlign.Center
                        MarkdownTable.Alignment.TRAILING -> TextAlign.End
                        else -> TextAlign.Start
                    }
                    Box(
                        Modifier.then(if (r == 0) Modifier.background(style.headerFill) else Modifier).padding(horizontal = 10.dp, vertical = 7.dp),
                        contentAlignment = when (align) {
                            TextAlign.Center -> Alignment.TopCenter
                            TextAlign.End -> Alignment.TopEnd
                            else -> Alignment.TopStart
                        },
                    ) {
                        Text(
                            inline(cell, style, previews, cards),
                            style = if (r == 0) text.copy(fontWeight = FontWeight.SemiBold) else text,
                            textAlign = align,
                        )
                    }
                }
            }
            // The hairlines between rows, laid out after the cells.
            repeat(table.rows.size) { Box(Modifier.background(style.line)) }
        },
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = spoken },
    ) { measurables, _ ->
        val cap = cellCap.roundToPx()
        val rowCount = table.rows.size + 1
        val cells = measurables.subList(0, rowCount * columns)
        val dividers = measurables.subList(rowCount * columns, measurables.size)
        val widths = IntArray(columns) { c ->
            (0 until rowCount).maxOf { r -> minOf(cells[r * columns + c].maxIntrinsicWidth(Constraints.Infinity), cap) }
        }
        val heights = IntArray(rowCount) { r ->
            (0 until columns).maxOf { c -> cells[r * columns + c].minIntrinsicHeight(widths[c]) }
        }
        val placeables = cells.mapIndexed { i, m ->
            val r = i / columns
            val c = i % columns
            m.measure(Constraints.fixed(widths[c], heights[r]))
        }
        val hairline = maxOf(1, (0.5f * density).toInt())
        val totalWidth = widths.sum()
        val totalHeight = heights.sum() + hairline * maxOf(0, rowCount - 1)
        val lines = dividers.map { it.measure(Constraints.fixed(totalWidth, hairline)) }
        layout(totalWidth, totalHeight) {
            var y = 0
            for (r in 0 until rowCount) {
                var x = 0
                for (c in 0 until columns) {
                    placeables[r * columns + c].place(x, y)
                    x += widths[c]
                }
                y += heights[r]
                if (r < rowCount - 1) {
                    lines.getOrNull(r)?.place(0, y)
                    y += hairline
                }
            }
        }
    }
}

/** A big table full screen: pinch to zoom, scroll both ways, the same copy actions. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TableScreen(table: MarkdownTable, previews: ChatPreviews?, cards: List<ChatPreviewLink>, onDismiss: () -> Unit) {
    val p = Nekko.palette
    var menu by remember { mutableStateOf(false) }
    var scale by remember { mutableFloatStateOf(1f) }
    val actions = rememberTableActions(table)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = onDismiss)
        // The dialog has its own window: its status bar icons follow the app's theme, as the activity's do.
        val view = LocalView.current
        val light = p.paper.luminance() > 0.5f
        LaunchedEffect(light) {
            (view.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
        }
        Scaffold(
            containerColor = p.paper,
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                    title = { Text("Table") },
                    navigationIcon = { IconButton(onClick = onDismiss, modifier = Modifier.testTag("markdown.table.done")) { Icon(Icons.Filled.Close, contentDescription = "Done") } },
                    actions = {
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.Share, contentDescription = "Table actions") }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) { TableActionItems(actions) { menu = false } }
                        }
                    },
                )
            },
        ) { padding ->
            Box(
                Modifier.fillMaxSize().padding(padding)
                    .pointerInput(Unit) { detectTransformGestures { _, _, zoom, _ -> scale = (scale * zoom).coerceIn(0.4f, 4f) } }
                    .verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()),
            ) {
                TableGrid(
                    table, MarkdownStyle.standard(p.ink), previews, cards, cellCap = 320.dp,
                    modifier = Modifier.padding(16.dp).graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        transformOrigin = TransformOrigin(0f, 0f)
                    }.border(1.dp, p.line, RoundedCornerShape(8.dp)),
                )
            }
        }
    }
}

// ---- inline ----

@Composable
private fun inline(s: String, style: MarkdownStyle, previews: ChatPreviews? = null, cards: List<ChatPreviewLink> = emptyList()): AnnotatedString {
    val links = TextLinkStyles(SpanStyle(color = style.link, textDecoration = TextDecoration.Underline))
    return remember(s, style, previews, cards) {
        buildAnnotatedString {
            for (span in Markdown.inline(s)) {
                val strike = Markdown.Style.STRIKE in span.styles
                val spanStyle = SpanStyle(
                    fontWeight = if (Markdown.Style.BOLD in span.styles) FontWeight.SemiBold else null,
                    fontStyle = if (Markdown.Style.ITALIC in span.styles) FontStyle.Italic else null,
                    fontFamily = if (Markdown.Style.CODE in span.styles) FontFamily.Monospace else null,
                    background = if (Markdown.Style.CODE in span.styles) style.codeFill else Color.Unspecified,
                    textDecoration = if (strike) TextDecoration.LineThrough else null,
                )
                val url = span.url
                val preview = if (url != null && previews != null) ChatLinks.preview(url, cards) else null
                if (preview != null) {
                    // A file or a loopback page: the preview window, never the phone's browser.
                    withLink(LinkAnnotation.Clickable("preview", links) { previews!!.open(preview) }) { withStyle(spanStyle) { append(span.text) } }
                } else if (url != null && safeLink(url)) {
                    withLink(LinkAnnotation.Url(url, links)) { withStyle(spanStyle) { append(span.text) } }
                } else {
                    withStyle(spanStyle) { append(span.text) }
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
internal fun CodeBlock(language: String, code: String, style: MarkdownStyle) {
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
            .background(style.codeFill)
            .border(1.dp, style.line, RoundedCornerShape(10.dp)),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                language.ifEmpty { "code" },
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = style.soft,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Code", code))) }
                copied = true
            }) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                    contentDescription = if (copied) "Copied" else "Copy code",
                    tint = style.soft,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Text(
            code,
            style = Nekko.mono.merge(TextStyle(color = style.codeInk)),
            softWrap = false,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
        )
    }
}
