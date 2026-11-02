package com.nekko.android.ui.chat

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.settings.modeDetailRes
import com.nekko.android.ui.settings.modeTitleRes
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PcSettings.ChatMode

/** The chat's ⋮ → Rename: the title on the computer, as on the desktop. */
@Composable
fun RenameChatDialog(title: String, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(title) }
    val ok = text.isNotBlank()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_rename_chat)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(stringResource(R.string.chat_title)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth().testTag("chat.rename.field"),
            )
        },
        confirmButton = { TextButton(onClick = { onRename(text.trim()) }, enabled = ok) { Text(stringResource(R.string.chat_rename)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.chat_cancel)) } },
    )
}

/**
 * The chat's ⋮ → Chat mode: this chat's tool policy on the computer. A chat
 * without one of its own follows the computer's default, which is what shows
 * as chosen. YOLO asks once before it is set; a raise is confirmed with the
 * fingerprint or screen lock by the caller.
 */
@Composable
fun ChatModeDialog(current: ChatMode?, default: ChatMode, computer: String, onDismiss: () -> Unit, onPick: (ChatMode) -> Unit) {
    val p = Nekko.palette
    val shown = current ?: default
    var askYolo by rememberSaveable { mutableStateOf(false) }
    if (askYolo) {
        AlertDialog(
            onDismissRequest = { askYolo = false },
            title = { Text(stringResource(R.string.chat_use_yolo_title)) },
            text = { Text(stringResource(R.string.chat_use_yolo_body, computer)) },
            confirmButton = { TextButton(onClick = { askYolo = false; onPick(ChatMode.YOLO) }) { Text(stringResource(R.string.chat_use_yolo), color = p.danger) } },
            dismissButton = { TextButton(onClick = { askYolo = false }) { Text(stringResource(R.string.chat_cancel)) } },
        )
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_chat_mode)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Column(Modifier.selectableGroup()) {
                    ChatMode.entries.forEach { m ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 56.dp)
                                .selectable(selected = shown == m, role = Role.RadioButton) {
                                    when {
                                        m == current -> onDismiss()
                                        m == ChatMode.YOLO -> askYolo = true
                                        else -> onPick(m)
                                    }
                                }
                                .padding(vertical = 6.dp)
                                .testTag("chat.toolMode.${m.wire}"),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            RadioButton(selected = shown == m, onClick = null)
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(modeTitleRes(m)), style = MaterialTheme.typography.bodyLarge, color = if (m == ChatMode.YOLO) p.danger else p.ink)
                                Text(stringResource(modeDetailRes(m)), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                            }
                        }
                    }
                }
                if (current == null) {
                    Text(
                        stringResource(R.string.chat_follows_default, computer, stringResource(modeTitleRes(default))),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkFaint,
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.chat_cancel)) } },
    )
}
