package com.nekko.android.ui.chat

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.data.OutboxItem
import com.nekko.android.ui.theme.Nekko

/**
 * The chat's prompts waiting in the outbox (offline mode): each with Edit
 * (back into the message box), Delete, and Send now for the whole list. The
 * one being delivered shows a spinner and can't be changed.
 */
@Composable
fun WaitingList(
    items: List<OutboxItem>,
    sendingId: String?,
    online: Boolean,
    onEdit: (String) -> Unit,
    onDelete: (String) -> Unit,
    onSendNow: () -> Unit,
) {
    if (items.isEmpty()) return
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface2).padding(horizontal = 12.dp, vertical = 8.dp).testTag("outbox.waiting"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
            Text(
                if (items.size == 1) stringResource(R.string.chat_waiting_to_send_one) else stringResource(R.string.chat_waiting_to_send_other, items.size),
                style = MaterialTheme.typography.labelLarge,
                color = p.inkSoft,
                modifier = Modifier.padding(start = 6.dp).weight(1f).semantics { heading() },
            )
            if (online && sendingId == null) TextButton(onClick = onSendNow, modifier = Modifier.testTag("outbox.sendNow")) { Text(stringResource(R.string.chat_send_now)) }
        }
        items.forEach { item ->
            val sending = item.id == sendingId
            Column(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(item.preview, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (sending) {
                        CircularProgressIndicator(Modifier.padding(horizontal = 12.dp).size(18.dp), strokeWidth = 2.dp, color = p.accent)
                    } else {
                        TextButton(onClick = { onEdit(item.id) }, modifier = Modifier.testTag("outbox.edit")) { Text(stringResource(R.string.chat_edit)) }
                        IconButton(onClick = { onDelete(item.id) }, modifier = Modifier.testTag("outbox.delete")) {
                            Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chat_delete_waiting), tint = p.inkSoft)
                        }
                    }
                }
                item.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
            }
        }
    }
}

/** The computer turned the last prompt down: why, above the message box that holds it again. */
@Composable
fun RefusalNote(reason: String, onDismiss: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.surface2).padding(start = 12.dp).testTag("outbox.refusal"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.chat_not_sent, reason), style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        IconButton(onClick = onDismiss) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chat_dismiss), tint = p.inkSoft) }
    }
}
