package com.nekko.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Prompt box. While a run is going, sending queues the prompt on the computer
 * and an empty box turns Send into Stop.
 */
@Composable
fun Composer(
    running: Boolean,
    blocked: String?,
    queued: List<String>,
    onSend: suspend (String) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf("") }
    var sending by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val canSend = text.isNotBlank() && blocked == null && !sending
    val showStop = running && text.isBlank()

    val send = {
        if (canSend) {
            val value = text.trim()
            sending = true
            text = ""
            error = null
            scope.launch {
                try {
                    onSend(value)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    text = value // keep what they typed if it didn't go
                    error = e.message ?: "Couldn’t send that."
                } finally {
                    sending = false
                }
            }
        }
    }

    Column(modifier.fillMaxWidth().background(p.paper)) {
        HorizontalDivider(color = p.line)
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (queued.isNotEmpty()) {
                Text(
                    if (queued.size == 1) "1 prompt queued after this run" else "${queued.size} prompts queued after this run",
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
                queued.takeLast(3).forEach { q ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
                        Text(q, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val note = blocked ?: error
            if (note != null) {
                Text(
                    note,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (blocked != null) p.warning else p.danger,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(p.surface)
                    .border(1.dp, p.line, RoundedCornerShape(16.dp))
                    .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                BasicTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        error = null
                    },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = p.ink),
                    cursorBrush = SolidColor(p.accent),
                    maxLines = 6,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .padding(vertical = 12.dp)
                        .semantics { contentDescription = "Message" },
                    decorationBox = { inner ->
                        if (text.isEmpty()) {
                            Text(
                                if (running) "Queue a follow-up…" else "Message your computer",
                                style = MaterialTheme.typography.bodyLarge,
                                color = p.inkFaint,
                            )
                        }
                        inner()
                    },
                )
                FilledIconButton(
                    onClick = { if (showStop) onStop() else send() },
                    enabled = showStop || canSend,
                    shape = CircleShape,
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = if (showStop) p.danger else p.accent,
                        contentColor = p.accentInk,
                        disabledContainerColor = p.surface2,
                        disabledContentColor = p.inkFaint,
                    ),
                    modifier = Modifier.size(48.dp),
                ) {
                    if (showStop) {
                        Icon(Icons.Filled.Stop, contentDescription = "Stop")
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = if (running) "Queue" else "Send")
                    }
                }
            }
        }
    }
}
