package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import android.content.ClipData
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.nekko.android.BuildConfig
import com.nekko.android.feedback.Feedback
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The three ways to send feedback (#1004): copy a prompt for the person's own
 * coding agent, send a quick note to Nekko Labs through Nekko Cloud, or open
 * GitHub issues. The note carries app info only when the switch is on.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackSheet(onDismiss: () -> Unit) {
    val p = Nekko.palette
    val info = remember {
        Feedback.AppInfo(
            version = BuildConfig.VERSION_NAME,
            osVersion = Build.VERSION.RELEASE,
            arch = Build.SUPPORTED_ABIS.firstOrNull(),
        )
    }
    // Fully open: the note's text box would sit under a half-open sheet's fold.
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = p.paper) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(stringResource(R.string.settings_send_feedback), style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.semantics { heading() })
            CopyForAgent(info)
            HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 6.dp))
            QuickNote(info)
            HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 6.dp))
            GitHubIssues()
        }
    }
}

@Composable
private fun Heading(title: String, detail: String) {
    val p = Nekko.palette
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = p.ink, modifier = Modifier.semantics { heading() })
        Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}

@Composable
private fun CopyForAgent(info: Feedback.AppInfo) {
    val p = Nekko.palette
    val prompt = remember(info) { Feedback.agentPrompt(info) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2000)
            copied = false
        }
    }
    val shape = RoundedCornerShape(10.dp)
    Heading(stringResource(R.string.settings_copy_for_agent), stringResource(R.string.settings_copy_for_agent_detail))
    Text(
        prompt,
        style = Nekko.mono.copy(color = p.inkSoft),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 140.dp)
            .background(p.code, shape)
            .border(1.dp, p.line, shape)
            .verticalScroll(rememberScrollState())
            .padding(10.dp),
    )
    Button(
        onClick = {
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Feedback prompt", prompt))) }
            // Android 13+ shows its own clipboard confirmation; the button saying so is enough on top of it.
            copied = true
        },
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) {
        Icon(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.size(8.dp))
        Text(if (copied) stringResource(R.string.settings_copied) else stringResource(R.string.settings_copy_prompt))
    }
}

@Composable
private fun QuickNote(info: Feedback.AppInfo) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf("") }
    var includeInfo by rememberSaveable { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var sent by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val counter = Feedback.counter(text.length)
    Heading(stringResource(R.string.settings_quick_note), stringResource(R.string.settings_quick_note_detail))
    if (sent) {
        Text(stringResource(R.string.settings_note_thanks), style = MaterialTheme.typography.bodyMedium, color = p.ink)
        TextButton(onClick = { sent = false }) { Text(stringResource(R.string.settings_write_another)) }
        return
    }
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it.take(Feedback.MAX_CHARS)
            error = null
        },
        label = { Text(stringResource(R.string.settings_note_label)) },
        supportingText = counter?.let { c -> @Composable { Text(c) } },
        enabled = !sending,
        minLines = 4,
        maxLines = 10,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(value = includeInfo, enabled = !sending, role = Role.Switch) { includeInfo = it }
            .heightIn(min = 56.dp)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.settings_include_info), style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(
                stringResource(R.string.settings_include_info_detail),
                style = MaterialTheme.typography.bodySmall,
                color = p.inkFaint,
            )
        }
        Switch(checked = includeInfo, onCheckedChange = null, enabled = !sending)
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = p.danger) }
    val message = Feedback.message(text)
    Button(
        onClick = {
            val m = message ?: return@Button
            sending = true
            error = null
            scope.launch {
                when (val outcome = Feedback.send(Feedback.body(m, if (includeInfo) info else null))) {
                    Feedback.Outcome.Sent -> {
                        text = ""
                        sent = true
                    }
                    is Feedback.Outcome.Failed -> error = outcome.message
                }
                sending = false
            }
        },
        enabled = message != null && !sending,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) {
        if (sending) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.settings_sending))
        } else {
            Text(stringResource(R.string.settings_send))
        }
    }
}

@Composable
private fun GitHubIssues() {
    val uriHandler = LocalUriHandler.current
    Heading(stringResource(R.string.settings_github_issues), stringResource(R.string.settings_github_issues_detail))
    OutlinedButton(
        // No browser on the phone is the only way this throws; there is nothing better to offer then.
        onClick = { runCatching { uriHandler.openUri(Feedback.NEW_ISSUE_URL) } },
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) {
        Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.size(8.dp))
        Text(stringResource(R.string.settings_github_issues))
    }
}
