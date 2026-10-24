package com.nekko.android.ui.settings

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
            Text("Send feedback", style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.semantics { heading() })
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
    Heading("Copy for an agent", "Paste it into Claude Code, Codex or Nekko Agent. It asks you a few questions and files a GitHub issue once you approve it.")
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
        Text(if (copied) "Copied" else "Copy prompt")
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
    Heading("Quick note", "Goes straight to Nekko Labs. No account, and nothing about you unless you add app info.")
    if (sent) {
        Text("Thanks, your note reached Nekko Labs.", style = MaterialTheme.typography.bodyMedium, color = p.ink)
        TextButton(onClick = { sent = false }) { Text("Write another") }
        return
    }
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it.take(Feedback.MAX_CHARS)
            error = null
        },
        label = { Text("What happened, or what you'd like") },
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
            Text("Include app info", style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(
                "App, version, OS and version, and CPU type. Nothing that identifies you.",
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
            Text("Sending…")
        } else {
            Text("Send")
        }
    }
}

@Composable
private fun GitHubIssues() {
    val uriHandler = LocalUriHandler.current
    Heading("Open GitHub issues", "See what others have reported, or file an issue in public.")
    OutlinedButton(
        // No browser on the phone is the only way this throws; there is nothing better to offer then.
        onClick = { runCatching { uriHandler.openUri(Feedback.NEW_ISSUE_URL) } },
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
    ) {
        Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.size(8.dp))
        Text("Open GitHub issues")
    }
}
