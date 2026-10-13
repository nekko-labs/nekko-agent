package com.nekko.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nekko.android.chat.AskForm
import com.nekko.android.chat.approvalDetail
import com.nekko.android.ui.components.Pill
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.components.toneColor
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.ASK_OTHER_LABEL
import com.nekko.protocol.Approval
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.Severity
import com.nekko.protocol.Transcript
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

@Composable
fun ApprovalCard(approval: Approval, onDecide: suspend (Boolean) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var busy by remember(approval.call.id) { mutableStateOf<Boolean?>(null) }
    var error by remember(approval.call.id) { mutableStateOf<String?>(null) }
    val tone = when (approval.severity) {
        Severity.HIGH -> Tone.DANGER
        Severity.MEDIUM -> Tone.WARNING
        Severity.LOW -> Tone.ACCENT
    }
    val edge = toneColor(tone)
    val isCommand = (approval.call.input["command"] as? JsonPrimitive)?.isString == true
    val decide = { ok: Boolean ->
        busy = ok
        error = null
        scope.launch {
            try {
                onDecide(ok)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn’t reach your computer."
            } finally {
                busy = null
            }
        }
        Unit
    }
    InputCardFrame(edge) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = edge, modifier = Modifier.size(18.dp))
            Text("Allow this?", style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.weight(1f))
            Pill("${approval.severity.name.lowercase()} risk", tone)
        }
        Text(
            if (isCommand) "Run this command on your computer:" else Transcript.toolLabel(approval.call),
            style = MaterialTheme.typography.bodyMedium,
            color = p.ink,
        )
        SelectionContainer {
            Text(
                approvalDetail(approval),
                style = Nekko.mono,
                color = p.ink,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 160.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(p.code)
                    .verticalScroll(rememberScrollState())
                    .padding(12.dp),
            )
        }
        if (approval.reason.isNotBlank()) {
            Text(approval.reason, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { decide(false) },
                enabled = busy == null,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (busy == false) "Denying…" else "Deny") }
            Button(
                onClick = { decide(true) },
                enabled = busy == null,
                colors = ButtonDefaults.buttonColors(containerColor = edge, contentColor = p.accentInk),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (busy == true) "Allowing…" else "Allow") }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuestionCard(request: AskRequest, onAnswer: suspend (List<AskAnswer>) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var form by remember(request.callId) { mutableStateOf(AskForm()) }
    var otherOpen by remember(request.callId) { mutableStateOf(emptySet<String>()) }
    var busy by remember(request.callId) { mutableStateOf(false) }
    var error by remember(request.callId) { mutableStateOf<String?>(null) }
    val submit = { answers: List<AskAnswer> ->
        busy = true
        error = null
        scope.launch {
            try {
                onAnswer(answers)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Couldn’t reach your computer."
            } finally {
                busy = false
            }
        }
        Unit
    }
    InputCardFrame(p.accent) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.AutoMirrored.Filled.HelpOutline, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
            Text("Nekko has a question", style = MaterialTheme.typography.titleMedium, color = p.ink)
        }
        Column(
            Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            request.questions.forEach { q ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (q.header.isNotBlank()) Pill(q.header, Tone.ACCENT)
                    Text(q.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
                    if (q.multiSelect) {
                        Text("Pick any", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        q.options.forEach { o ->
                            val on = form.isPicked(q, o.label)
                            FilterChip(
                                selected = on,
                                onClick = { form = form.toggle(q, o.label) },
                                leadingIcon = {
                                    if (on) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                                },
                                label = {
                                    Column(Modifier.padding(vertical = 6.dp)) {
                                        Text(o.label, fontWeight = FontWeight.SemiBold)
                                        o.description?.takeIf { it.isNotBlank() }?.let {
                                            Text(it, style = MaterialTheme.typography.bodySmall)
                                        }
                                    }
                                },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = p.accent,
                                    selectedLabelColor = p.accentInk,
                                    selectedLeadingIconColor = p.accentInk,
                                ),
                                modifier = Modifier.heightIn(min = 48.dp),
                            )
                        }
                        val noteOpen = q.id in otherOpen || !form.notes[q.id].isNullOrEmpty()
                        FilterChip(
                            selected = noteOpen,
                            onClick = { otherOpen = if (q.id in otherOpen) otherOpen - q.id else otherOpen + q.id },
                            leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null, modifier = Modifier.size(16.dp)) },
                            label = { Text(ASK_OTHER_LABEL) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                    if (q.id in otherOpen || !form.notes[q.id].isNullOrEmpty()) {
                        OutlinedTextField(
                            value = form.notes[q.id].orEmpty(),
                            onValueChange = { form = form.note(q, it) },
                            placeholder = { Text("$ASK_OTHER_LABEL — type it here") },
                            label = { Text(ASK_OTHER_LABEL) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { submit(emptyList()) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("You decide")
            }
            Button(
                onClick = { submit(form.answers(request)) },
                enabled = !busy && form.complete(request),
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) { Text(if (busy) "Sending…" else "Submit") }
        }
    }
}

@Composable
private fun InputCardFrame(edge: androidx.compose.ui.graphics.Color, content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(p.surface)
            .border(1.dp, edge, RoundedCornerShape(16.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) { content() }
}
