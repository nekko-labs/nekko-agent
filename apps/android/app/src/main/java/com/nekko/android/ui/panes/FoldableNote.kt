package com.nekko.android.ui.panes

import androidx.compose.ui.res.stringResource
import com.nekko.android.R
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko

/** Where "let us know" goes: the repo's public issue tracker. */
const val FOLDABLE_NOTE_URL = "https://github.com/nekko-labs/nekko-agent/issues/new"

/**
 * The owner's note on the folding-phone UI (panes, tabletop), word for word
 * (R.string.chats_foldable_note): shown small and unobtrusive wherever that UI
 * appears. "let us know" opens the public issue tracker; the whole note is the
 * tap target. Here as a caption row. [onDismiss] adds a close button (the footnote on
 * the first two-pane open, remembered per phone); null for the Replace with… menu's footer.
 */
@Composable
fun FoldableNote(modifier: Modifier = Modifier, onDismiss: (() -> Unit)? = null) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    val note = stringResource(R.string.chats_foldable_note)
    val link = stringResource(R.string.chats_foldable_note_link)
    val at = note.indexOf(link)
    val text = buildAnnotatedString {
        if (at < 0) {
            append(note)
        } else {
            append(note.substring(0, at))
            withStyle(SpanStyle(color = p.accent, textDecoration = TextDecoration.Underline)) { append(link) }
            append(note.substring(at + link.length))
        }
    }
    Row(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.chats_report_issue)) { uri.openUri(FOLDABLE_NOTE_URL) }
            .padding(start = 12.dp, end = if (onDismiss == null) 12.dp else 0.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Info, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.weight(1f))
        if (onDismiss != null) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.chats_dismiss_note), tint = p.inkFaint, modifier = Modifier.size(16.dp))
            }
        }
    }
}
