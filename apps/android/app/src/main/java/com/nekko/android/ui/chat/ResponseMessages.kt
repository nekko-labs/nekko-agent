package com.nekko.android.ui.chat

import androidx.compose.foundation.background
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.data.ResponseMessage
import com.nekko.android.data.ResponseMessage.Status
import com.nekko.android.ui.theme.Nekko

/**
 * An answer or approval kept as a message while the computer is away, not a failed form (the
 * iPhone's ResponseMessageRow, #2497): what was said, where it stands, the original request's
 * identifier, and Retry and Cancel until it is being sent.
 */
@Composable
fun ResponseMessageRow(message: ResponseMessage, onRetry: () -> Unit, onCancel: () -> Unit) {
    val p = Nekko.palette
    val status = stringResource(
        when (message.status) {
            Status.SENDING -> R.string.response_sending
            Status.SENT -> R.string.response_sent
            Status.STALE -> R.string.response_stale
            Status.FAILED -> R.string.response_failed
            Status.WAITING -> R.string.response_waiting
        },
    )
    val requestLabel = stringResource(R.string.response_request_id, message.pendingId)
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("chat.response"), contentAlignment = Alignment.CenterEnd) {
        Column(
            Modifier
                .widthIn(max = 320.dp)
                .background(p.surface2, RoundedCornerShape(16.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(message.text, style = MaterialTheme.typography.bodyMedium, color = p.ink, textAlign = TextAlign.End)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (message.status == Status.SENDING) CircularProgressIndicator(strokeWidth = 2.dp, color = p.inkSoft, modifier = Modifier.size(12.dp))
                Text(status, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.testTag("response.status"))
            }
            Text(
                message.pendingId,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = p.inkFaint,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.semantics { contentDescription = requestLabel },
            )
            // The computer's own words for a failure; a request that moved on is said in the phone's language.
            val error = if (message.status == Status.STALE) stringResource(R.string.response_stale_detail) else message.error
            error?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, textAlign = TextAlign.End) }
            if (message.actionable) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("response.retry")) { Text(stringResource(R.string.response_retry), color = p.accent) }
                    TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp).testTag("response.cancel")) { Text(stringResource(R.string.response_cancel), color = p.danger) }
                }
            }
        }
    }
}
