package com.nekko.android.ui.chat

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.contextmenu.builder.item
import androidx.compose.foundation.text.contextmenu.data.TextContextMenuKeys
import androidx.compose.foundation.text.contextmenu.modifier.appendTextContextMenuComponents
import androidx.compose.foundation.text.contextmenu.modifier.filterTextContextMenuComponents
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.filled.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.FormatBold
import androidx.compose.material.icons.filled.FormatItalic
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.FormatQuote
import androidx.compose.material.icons.filled.FormatStrikethrough
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Title
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.core.content.edit
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.MarkdownAction
import com.nekko.protocol.MarkdownEdit
import com.nekko.protocol.MarkdownEditing
import com.nekko.protocol.MarkdownHighlight
import com.nekko.protocol.MarkdownSelection
import com.nekko.protocol.MarkdownSpan
import com.nekko.protocol.RichPaste
import kotlinx.coroutines.delay

// The message box's Markdown (MD-6, the iPhone's MD-3 and MD-4): the source
// with light live styling, the formatting toolbar inside the card above the
// text, list continuation on Return, Tab through a table, and the paste
// choice. What is sent is exactly what was typed.

/**
 * What the composer's text field and its toolbar share: the selection, and a
 * paste to offer formatting for. The draft's text itself stays the composer's
 * (it is set from many places: a send, dictation, a shared text).
 */
@Stable
internal class MarkdownDraft {
    /** The field's last value (text, selection, the keyboard's composition). */
    var value by mutableStateOf(TextFieldValue(""))

    /** The last normal paste of rich text: where its plain text went, and its Markdown. */
    var pasted by mutableStateOf<Pasted?>(null)

    class Pasted(val start: Int, val plain: String, val markdown: String)

    /** The field's value for [text]: the last one when it still holds that text, else the caret at its end (text set from outside). */
    fun valueFor(text: String): TextFieldValue = if (value.text == text) value else TextFieldValue(text, TextRange(text.length))

    fun selection(text: String): MarkdownSelection = valueFor(text).selection.let { MarkdownSelection(it.min, it.max - it.min) }

    /** Apply an edit: the text goes to [setText], the selection stays here. */
    fun apply(edit: MarkdownEdit, setText: (String) -> Unit) {
        value = TextFieldValue(edit.text, TextRange(edit.location, edit.location + edit.length))
        setText(edit.text)
    }

    /**
     * The field typed something: Return on a list line continues it (or ends it
     * on an empty item); when lines come or go a numbered list counts again.
     */
    fun changed(old: TextFieldValue, new: TextFieldValue, setText: (String) -> Unit) {
        if (new.text != old.text) {
            val sel = old.selection
            val isReturn = new.text.length == old.text.length - (sel.max - sel.min) + 1 &&
                new.text == old.text.replaceRange(sel.min, sel.max, "\n") && new.selection.collapsed && new.selection.start == sel.min + 1
            if (isReturn) {
                MarkdownEditing.newline(old.text, MarkdownSelection(sel.min, sel.max - sel.min))?.let { return apply(it, setText) }
            }
            if (new.text.count { it == '\n' } != old.text.count { it == '\n' }) {
                val e = MarkdownEditing.renumbered(MarkdownEdit(new.text, new.selection.min, new.selection.max - new.selection.min))
                if (e.text != new.text) return apply(e, setText)
            }
            pasted = null
        }
        value = new
        setText(new.text)
    }

    /** Tab (a hardware keyboard): the next table cell, or one list level deeper (Shift: shallower). False when neither applies. */
    fun tab(text: String, shift: Boolean, setText: (String) -> Unit): Boolean {
        val sel = selection(text)
        if (!shift) MarkdownEditing.nextCell(text, sel)?.let { apply(it, setText); return true }
        val (start, end) = MarkdownEditing.lineRange(text, sel.location)
        if (!LIST_LINE.containsMatchIn(text.substring(start, end))) return false
        apply(MarkdownEditing.indent(text, sel, outdent = shift), setText)
        return true
    }

    /** Insert [s] over the selection, the caret after it. */
    fun insert(text: String, s: String, setText: (String) -> Unit): Int {
        val sel = selection(text)
        apply(MarkdownEdit(text.replaceRange(sel.location, sel.end, s), sel.location + s.length), setText)
        return sel.location
    }

    companion object {
        private val LIST_LINE = Regex("""^[ \t]*(?:[-+*] |\d{1,9}[.)] )""")
    }
}

/** The source drawn with light styling: bold looks bold with its `**` dimmed, headings larger, markers tinted, code monospaced. */
internal class MarkdownStyling(private val faint: Color, private val accent: Color, private val codeFill: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val spans = MarkdownHighlight.spans(text.text)
        if (spans.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val styled = AnnotatedString(
            text.text,
            spanStyles = spans.mapNotNull { s ->
                val style = when (val k = s.kind) {
                    is MarkdownSpan.Kind.Heading -> SpanStyle(fontWeight = FontWeight.SemiBold, fontSize = if (k.level <= 1) 1.25.em else if (k.level == 2) 1.15.em else 1.05.em)
                    MarkdownSpan.Kind.Syntax -> SpanStyle(color = faint)
                    MarkdownSpan.Kind.Marker -> SpanStyle(color = accent)
                    MarkdownSpan.Kind.Bold -> SpanStyle(fontWeight = FontWeight.Bold)
                    MarkdownSpan.Kind.Italic -> SpanStyle(fontStyle = FontStyle.Italic)
                    MarkdownSpan.Kind.Strike -> SpanStyle(textDecoration = TextDecoration.LineThrough)
                    MarkdownSpan.Kind.Code -> SpanStyle(fontFamily = FontFamily.Monospace, background = codeFill)
                    MarkdownSpan.Kind.Link -> SpanStyle(color = accent, textDecoration = TextDecoration.Underline)
                    MarkdownSpan.Kind.Fence -> SpanStyle(fontFamily = FontFamily.Monospace)
                }
                if (s.end <= text.length && s.length > 0) AnnotatedString.Range(style, s.start, s.end) else null
            },
        )
        return TransformedText(styled, OffsetMapping.Identity)
    }

    override fun equals(other: Any?) = other is MarkdownStyling && other.faint == faint && other.accent == accent && other.codeFill == codeFill
    override fun hashCode() = listOf(faint, accent, codeFill).hashCode()
}

/** The field's hardware-keyboard rules: Tab and Shift-Tab. */
internal fun Modifier.markdownKeys(draft: MarkdownDraft, text: () -> String, setText: (String) -> Unit): Modifier = onPreviewKeyEvent { e ->
    e.type == KeyEventType.KeyDown && e.key == Key.Tab && draft.tab(text(), e.isShiftPressed, setText)
}

private object PasteKey
private object PasteMarkdownKey
private object PastePlainKey

/**
 * The long-press menu's paste choice. The system's Paste is replaced by ours,
 * which still pastes plain text but, after rich text, offers its Markdown for
 * a few seconds; *Paste as Markdown* converts clipboard HTML (a browser,
 * Mail, Google Docs); *Paste as plain text* pastes the clipboard's text
 * literally. The clipboard is read only when one of them is picked.
 */
internal fun Modifier.markdownPaste(context: Context, draft: MarkdownDraft, text: () -> String, setText: (String) -> Unit): Modifier {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    fun read(): Pair<String, String?>? {
        val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return null
        val plain = item.coerceToText(context)?.toString().orEmpty()
        return plain to item.htmlText
    }
    return filterTextContextMenuComponents { it.key != TextContextMenuKeys.PasteKey }
        .appendTextContextMenuComponents {
            if (!clipboard.hasPrimaryClip()) return@appendTextContextMenuComponents
            item(PasteKey, "Paste") {
                read()?.let { (plain, html) ->
                    val at = draft.insert(text(), plain, setText)
                    val markdown = if (html != null) RichPaste.markdown(html, plain) else plain
                    draft.pasted = if (markdown != plain && plain.isNotEmpty()) MarkdownDraft.Pasted(at, plain, markdown) else null
                }
                close()
            }
            item(PasteMarkdownKey, "Paste as Markdown") {
                read()?.let { (plain, html) -> draft.insert(text(), RichPaste.markdown(html, plain), setText) }
                draft.pasted = null
                close()
            }
            item(PastePlainKey, "Paste as plain text") {
                read()?.let { (plain, _) -> draft.insert(text(), plain, setText) }
                draft.pasted = null
                close()
            }
        }
}

/** After a normal paste of rich text: *Pasted as text · Use formatting* for four seconds; tapping swaps the pasted text for its Markdown. */
@Composable
internal fun PastedChip(draft: MarkdownDraft, text: String, setText: (String) -> Unit) {
    val pasted = draft.pasted ?: return
    val p = Nekko.palette
    LaunchedEffect(pasted) {
        delay(4_000)
        if (draft.pasted === pasted) draft.pasted = null
    }
    Row(
        Modifier.clip(RoundedCornerShape(12.dp)).background(p.surface2)
            .clickable {
                val end = pasted.start + pasted.plain.length
                if (end <= text.length && text.substring(pasted.start, end) == pasted.plain) {
                    draft.apply(MarkdownEdit(text.replaceRange(pasted.start, end, pasted.markdown), pasted.start + pasted.markdown.length), setText)
                }
                draft.pasted = null
            }
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .testTag("composer.useFormatting"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Pasted as text · ", style = MaterialTheme.typography.labelMedium, color = p.inkSoft)
        Text("Use formatting", style = MaterialTheme.typography.labelMedium, color = p.accent, fontWeight = FontWeight.SemiBold)
    }
}

private val ICONS: Map<MarkdownAction, ImageVector> = mapOf(
    MarkdownAction.BOLD to Icons.Filled.FormatBold,
    MarkdownAction.ITALIC to Icons.Filled.FormatItalic,
    MarkdownAction.STRIKE to Icons.Filled.FormatStrikethrough,
    MarkdownAction.CODE to Icons.Filled.Code,
    MarkdownAction.LINK to Icons.Filled.Link,
    MarkdownAction.HEADING to Icons.Filled.Title,
    MarkdownAction.BULLET to Icons.AutoMirrored.Filled.FormatListBulleted,
    MarkdownAction.ORDERED to Icons.Filled.FormatListNumbered,
    MarkdownAction.TASK to Icons.Filled.Checklist,
    MarkdownAction.INDENT to Icons.AutoMirrored.Filled.FormatIndentIncrease,
    MarkdownAction.OUTDENT to Icons.AutoMirrored.Filled.FormatIndentDecrease,
    MarkdownAction.QUOTE to Icons.Filled.FormatQuote,
    MarkdownAction.FENCE to Icons.Filled.DataObject,
    MarkdownAction.TABLE to Icons.Filled.TableChart,
)

/**
 * The formatting toolbar, inside the message card above the text: bold,
 * italic, strikethrough, inline code, link, heading, bulleted, numbered and
 * task lists, indent and outdent, quote, code block and table; while the caret
 * is in a table, *Add row* and *Add column* come first. A button shows pressed when
 * the selection already has its style; pressing it again removes it.
 */
@Composable
internal fun MarkdownToolbar(draft: MarkdownDraft, text: String, setText: (String) -> Unit) {
    val p = Nekko.palette
    val sel = draft.selection(text)
    val inTable = MarkdownEditing.tableLines(text, sel.location) != null
    val scroll = rememberScrollState()
    // Entering a table brings its actions (first in the row) into view.
    LaunchedEffect(inTable) { if (inTable) scroll.animateScrollTo(0) }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(scroll).testTag("composer.toolbar"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // In a table, its own actions come first, where they are seen without scrolling.
        if (inTable) {
            TextButton(
                onClick = { MarkdownEditing.addRow(text, draft.selection(text))?.let { draft.apply(it, setText) } },
                contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 40.dp),
            ) { Text("Add row") }
            TextButton(
                onClick = { MarkdownEditing.addColumn(text, draft.selection(text))?.let { draft.apply(it, setText) } },
                contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 40.dp),
            ) { Text("Add column") }
        }
        for (action in MarkdownAction.entries) {
            val on = action.toggles && MarkdownEditing.isActive(action, text, sel)
            Box(
                Modifier.size(40.dp).clip(RoundedCornerShape(10.dp)).background(if (on) p.accent.copy(alpha = 0.16f) else Color.Transparent)
                    .clickable { draft.apply(MarkdownEditing.apply(action, text, draft.selection(text)), setText) }
                    .semantics {
                        contentDescription = action.label
                        role = Role.Button
                        if (action.toggles) selected = on
                    }
                    .testTag("composer.format.${action.name.lowercase()}"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(ICONS.getValue(action), contentDescription = null, tint = if (on) p.accent else p.inkSoft, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Whether the toolbar shows (the *Aa* button), remembered on the phone. */
internal object ToolbarPref {
    private const val FILE = "nekko.composer"
    private const val KEY = "markdownToolbar"

    fun get(context: Context): Boolean = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY, true)

    fun set(context: Context, on: Boolean) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putBoolean(KEY, on) }
}
