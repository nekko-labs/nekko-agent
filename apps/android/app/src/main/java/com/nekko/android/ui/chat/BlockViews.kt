package com.nekko.android.ui.chat

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Block
import com.nekko.protocol.ToolStatus

@Composable
fun BlockView(block: Block) {
    when (block) {
        is Block.User -> UserBubble(block)
        is Block.Assistant -> Reply(block)
        is Block.Tool -> ToolRow(block)
    }
}

@Composable
private fun UserBubble(b: Block.User) {
    val p = Nekko.palette
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Column(
            Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp))
                .background(p.userBubble)
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            SelectionContainer {
                Text(b.text, style = MaterialTheme.typography.bodyLarge, color = p.userInk)
            }
            if (b.images > 0) {
                Text(
                    if (b.images == 1) "1 image" else "${b.images} images",
                    style = MaterialTheme.typography.bodySmall,
                    color = p.userInk.copy(alpha = 0.7f),
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun Reply(b: Block.Assistant) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val reasoning = b.reasoning
    val thinkingOnly = b.streaming && b.text.isEmpty() && !reasoning.isNullOrEmpty()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!reasoning.isNullOrEmpty()) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(role = Role.Button) { open = !open }
                    .heightIn(min = 48.dp)
                    .padding(horizontal = 4.dp)
                    .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Psychology, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(16.dp))
                Text(
                    when {
                        thinkingOnly && !open -> "Thinking…"
                        open -> "Hide reasoning"
                        else -> "Show reasoning"
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
            SelectionContainer {
                Text(b.text, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            }
        } else if (b.streaming && reasoning.isNullOrEmpty()) {
            CircularProgressIndicator(
                color = p.accent,
                strokeWidth = 2.dp,
                modifier = Modifier.size(18.dp).semantics { contentDescription = "Writing" },
            )
        }
        if (b.interrupted) {
            Text("Stopped before finishing.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
    }
}

@Composable
private fun ToolRow(b: Block.Tool) {
    val p = Nekko.palette
    var open by rememberSaveable(b.id) { mutableStateOf(false) }
    val color = when (b.status) {
        ToolStatus.RUNNING -> p.running
        ToolStatus.WAITING -> p.warning
        ToolStatus.OK -> p.success
        ToolStatus.ERROR -> p.danger
    }
    val statusText = when (b.status) {
        ToolStatus.RUNNING -> "running"
        ToolStatus.WAITING -> "waiting for you"
        ToolStatus.OK -> "done"
        ToolStatus.ERROR -> "failed"
    }
    val hasOutput = !b.output.isNullOrEmpty()
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.surface)
            .border(1.dp, p.line, RoundedCornerShape(12.dp)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = hasOutput, role = Role.Button) { open = !open }
                .heightIn(min = 48.dp)
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .semantics(mergeDescendants = true) { contentDescription = "${b.label}, $statusText" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (b.status == ToolStatus.RUNNING) {
                CircularProgressIndicator(color = color, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
            } else {
                Icon(
                    when (b.status) {
                        ToolStatus.OK -> Icons.Filled.Check
                        ToolStatus.WAITING -> Icons.Filled.Warning
                        ToolStatus.ERROR -> Icons.Filled.Close
                        else -> Icons.Filled.Build
                    },
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(16.dp),
                )
            }
            Text(
                b.label,
                style = MaterialTheme.typography.bodyMedium,
                color = p.inkSoft,
                maxLines = if (open) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (hasOutput) {
                Icon(
                    if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = p.inkFaint,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        if (open && hasOutput) {
            SelectionContainer {
                Text(
                    b.output.orEmpty(),
                    style = Nekko.mono,
                    color = p.inkSoft,
                    maxLines = 40,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                )
            }
        }
    }
}
