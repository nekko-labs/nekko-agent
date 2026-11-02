package com.nekko.android.ui.chat

import android.content.ClipData
import android.content.Context
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.previews.PreviewCards
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.AgentRows
import com.nekko.protocol.Block
import com.nekko.protocol.Purpose
import com.nekko.protocol.PurposeCall
import com.nekko.protocol.ToolPurpose
import com.nekko.protocol.Transcript
import com.nekko.protocol.ToolStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What a long press on a message offers besides Copy: fork the chat from it
 * (AN-29). *Edit in a new chat* on a prompt, *Fork from here* on a reply.
 */
data class ForkAction(val label: String, val run: () -> Unit)

@Composable
fun BlockView(block: Block, fork: ForkAction? = null) {
    when (block) {
        // A watch's wake-up is a step of the run, not something the user typed.
        is Block.User -> AgentRows.parseWake(block.text)?.takeIf { block.thumbs.isEmpty() }?.let { WatchWakeRow(it, block.text, block.at) }
            ?: UserBubble(block, fork)
        is Block.Assistant -> Reply(block, fork)
        // The agent's work, drawn as the desktop draws it: no fill, no stroke, one line each.
        is Block.Tool -> AgentToolRow(block)
    }
}

@Composable
private fun UserBubble(b: Block.User, fork: ForkAction?) {
    val p = Nekko.palette
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Column(
            Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp))
                .background(p.userBubble)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            if (b.thumbs.isNotEmpty()) {
                PromptPhotos(b.thumbs, tint = p.userInk.copy(alpha = 0.7f), tile = p.userInk.copy(alpha = 0.12f))
            }
            if (b.text.isNotEmpty()) {
                LongPressMenu(b.text, fork) { press ->
                    // The user's own Markdown renders too, in the bubble's ink (as the desktop does, T101).
                    MarkdownText(
                        b.text,
                        color = p.userInk,
                        bubble = true,
                        modifier = Modifier.padding(top = if (b.thumbs.isNotEmpty()) 8.dp else 0.dp).then(press),
                    )
                }
            }
        }
    }
}

@Composable
private fun Reply(b: Block.Assistant, fork: ForkAction?) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val reasoning = b.reasoning
    val thinkingOnly = b.streaming && b.text.isEmpty() && !reasoning.isNullOrEmpty()
    val expanded = stringResource(R.string.chat_expanded)
    val collapsed = stringResource(R.string.chat_collapsed)
    val writing = stringResource(R.string.chat_writing)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!reasoning.isNullOrEmpty()) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button) { open = !open }
                    .heightIn(min = 48.dp)
                    .padding(horizontal = 4.dp)
                    .semantics { stateDescription = if (open) expanded else collapsed },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Psychology, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(16.dp))
                Text(
                    when {
                        thinkingOnly && !open -> stringResource(R.string.chat_thinking)
                        open -> stringResource(R.string.chat_hide_reasoning)
                        else -> stringResource(R.string.chat_show_reasoning)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
            }
            if (open || thinkingOnly) {
                Row(Modifier.fillMaxWidth()) {
                    Box(Modifier.size(width = 2.dp, height = 16.dp).background(p.line))
                    Text(
                        if (open) reasoning else reasoning.takeLast(600),
                        style = MaterialTheme.typography.bodyMedium,
                        color = p.inkFaint,
                        maxLines = if (open) Int.MAX_VALUE else 4,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 12.dp).animateContentSize(),
                    )
                }
            }
        }
        if (b.text.isNotEmpty()) {
            LongPressMenu(b.text, fork) { press -> MarkdownText(b.text, color = p.ink, modifier = Modifier.fillMaxWidth().then(press)) }
            // Cards come once the reply is finished; a tapped link works meanwhile.
            if (!b.streaming) PreviewCards(b.text)
        } else if (b.streaming && reasoning.isNullOrEmpty()) {
            CircularProgressIndicator(
                color = p.accent,
                strokeWidth = 2.dp,
                modifier = Modifier.size(18.dp).semantics { contentDescription = writing },
            )
        }
        if (b.interrupted) {
            Text(stringResource(R.string.chat_stopped_before_finishing), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
    }
}

/**
 * Adjacent calls with one purpose as one row that says the goal ("Read the
 * project's guidance", "Ran the tests") with a quiet detail line, opening to
 * the calls as they look on their own (spec/chat/tool-calls-grouped-by-purpose.md).
 * Present tense with the running dots while a call in it runs; a group with a
 * failed call says so and starts open, so the failure is not hidden.
 */
@Composable
fun PurposeGroupCard(purpose: ToolPurpose, blocks: List<Block>, calls: List<PurposeCall>) {
    val p = Nekko.palette
    val running = blocks.any { it is Block.Tool && it.status == ToolStatus.RUNNING }
    val h = Purpose.headline(purpose, calls, running)
    // The detail without the failure count, which is drawn in its own colour.
    val quiet = if (h.failed > 0 && purpose == ToolPurpose.CHECK && !running) ""
        else Purpose.headline(purpose, calls.map { it.copy(failed = false) }, running).detail
    var chosen by rememberSaveable(blocks.firstOrNull()?.id) { mutableStateOf<Boolean?>(null) }
    val open = chosen ?: (h.failed > 0)
    val count = if (calls.size == 1) stringResource(R.string.chat_calls_one) else stringResource(R.string.chat_calls_other, calls.size)
    val callsShown = stringResource(R.string.chat_calls_shown)
    val callsHidden = stringResource(R.string.chat_calls_hidden)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .clickable(role = Role.Button) { chosen = !open }
                .heightIn(min = 36.dp)
                .semantics(mergeDescendants = true) {
                    contentDescription = listOf(h.headline, h.detail, count).filter { it.isNotEmpty() }.joinToString(", ")
                    stateDescription = if (open) callsShown else callsHidden
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (running) RunningDots() else StepMark(if (h.failed > 0) ToolStatus.ERROR else ToolStatus.OK)
            Column(Modifier.weight(1f)) {
                Text(
                    h.headline,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = if (running) p.accent else p.inkSoft,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (quiet.isNotEmpty() || h.failed > 0) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (quiet.isNotEmpty()) {
                            Text(quiet, style = Nekko.mono, color = p.inkFaint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        }
                        if (h.failed > 0) Text(stringResource(R.string.chat_n_failed, h.failed), style = Nekko.mono, color = p.danger)
                    }
                }
            }
            RowChip("${calls.size}", tone = AgentRows.Tone.QUIET)
            Icon(
                if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = null,
                tint = p.inkFaint,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) Hairline { blocks.forEach { BlockView(it) } }
    }
}

/**
 * A message's long press: Copy at once, or with a [fork] a small menu of
 * Copy and the fork (accessibility actions for both).
 */
@Composable
private fun LongPressMenu(text: String, fork: ForkAction?, content: @Composable (Modifier) -> Unit) {
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    if (fork == null) {
        content(Modifier.onLongPress(text, stringResource(R.string.chat_copy_message)) { copy(scope, clipboard, context, text) })
        return
    }
    var open by remember { mutableStateOf(false) }
    Box {
        content(
            Modifier.onLongPress(text, stringResource(R.string.chat_copy_or_fork)) { open = true }
                .semantics { customActions = listOf(CustomAccessibilityAction(fork.label) { fork.run(); true }) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.chat_copy)) }, onClick = { open = false; copy(scope, clipboard, context, text) })
            DropdownMenuItem(text = { Text(fork.label) }, onClick = { open = false; fork.run() }, modifier = Modifier.testTag("message.fork"))
        }
    }
}

/**
 * A long press on the whole message. Messages are not wrapped in a
 * SelectionContainer: its press-and-drag gesture starts a text selection and
 * swallows the drag, so a chat of long messages (one can fill the screen)
 * could not be scrolled by a finger that rests before moving. This gesture
 * never consumes anything: a press that moves first is the list's scroll, and
 * a drag after the copy still scrolls the list.
 */
@Composable
private fun Modifier.onLongPress(text: String, label: String, action: () -> Unit): Modifier {
    val haptics = LocalHapticFeedback.current
    return this
        .semantics { onLongClick(label = label) { action(); true } }
        .pointerInput(text) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                // Null when the press outlasts the long-press timeout without moving or lifting.
                val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                    var done = false
                    while (!done) {
                        val c = awaitPointerEvent(PointerEventPass.Final).changes.firstOrNull { it.id == down.id }
                        done = c == null || !c.pressed || c.isConsumed ||
                            (c.position - down.position).getDistance() > viewConfiguration.touchSlop
                    }
                    true
                }
                if (ended == null) {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    action()
                }
            }
        }
}

private fun copy(scope: CoroutineScope, clipboard: Clipboard, context: Context, text: String) {
    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Message", text))) }
    // Android 13+ shows its own copied confirmation.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, context.getString(R.string.chat_copied), Toast.LENGTH_SHORT).show()
}
