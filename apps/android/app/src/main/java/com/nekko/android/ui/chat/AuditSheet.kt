package com.nekko.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.settings.modeTitleRes
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Audit
import com.nekko.protocol.PcSettings.ChatMode
import java.text.DateFormat
import java.util.Date

/**
 * A chat's audit trail, read only, as on the desktop: every turn, tool call and
 * approval, and who answered. Value-free: it never shows what the agent read or sent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuditSheet(trail: List<Audit.Event>?, error: String?, onRefresh: () -> Unit, onDismiss: () -> Unit) {
    val p = Nekko.palette
    var onlyDecisions by rememberSaveable { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper, modifier = Modifier.testTag("chat.audit.sheet")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.chat_audit_trail), style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.weight(1f).semantics { heading() })
            TextButton(onClick = onRefresh) { Text(stringResource(R.string.chat_refresh)) }
        }
        Text(
            stringResource(R.string.chat_audit_intro),
            style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        val decisions = trail.orEmpty().count(Audit::isDecision)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
            SegmentedButton(
                selected = !onlyDecisions, onClick = { onlyDecisions = false },
                shape = SegmentedButtonDefaults.itemShape(0, 2), modifier = Modifier.testTag("chat.audit.everything"),
            ) { Text(stringResource(R.string.chat_audit_everything)) }
            SegmentedButton(
                selected = onlyDecisions, onClick = { onlyDecisions = true },
                shape = SegmentedButtonDefaults.itemShape(1, 2), modifier = Modifier.testTag("chat.audit.approvals"),
            ) { Text(if (decisions > 0) stringResource(R.string.chat_audit_approvals_count, decisions) else stringResource(R.string.chat_audit_approvals)) }
        }
        val t = trail
        when {
            t == null && error != null -> AuditNotice(stringResource(R.string.chat_audit_load_failed), error)
            t == null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            t.isEmpty() -> AuditNotice(stringResource(R.string.chat_audit_empty_title), stringResource(R.string.chat_audit_empty))
            else -> {
                val turns = remember(t, onlyDecisions) { Audit.shown(t, onlyDecisions) }
                if (turns.isEmpty()) {
                    AuditNotice(stringResource(R.string.chat_audit_no_approvals), "")
                } else {
                    LazyColumn(Modifier.fillMaxWidth().testTag("chat.audit.list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        items(turns, key = { "${it.turnId}-${it.start?.at ?: it.events.firstOrNull()?.at}" }) { TurnSection(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AuditNotice(title: String, body: String) {
    val p = Nekko.palette
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = p.ink)
        if (body.isNotEmpty()) Text(body, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}

private val timeFormat: DateFormat get() = DateFormat.getTimeInstance(DateFormat.MEDIUM)

@Composable
private fun TurnSection(turn: Audit.TurnGroup) {
    val p = Nekko.palette
    val start = turn.start
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val mode = ChatMode.of(start?.mode)
            Text(
                if (start == null) stringResource(R.string.chat_audit_turn_plain)
                else stringResource(R.string.chat_audit_turn, mode?.let { stringResource(modeTitleRes(it)) } ?: (start.mode ?: stringResource(modeTitleRes(ChatMode.GUARDRAILS)))),
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = p.ink,
            )
            val model = listOfNotNull(if (start?.claudeCode == true) "Claude Code" else null, start?.model).joinToString(" · ")
            Text(model, style = MaterialTheme.typography.labelMedium, color = p.inkFaint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (start != null) Text(timeFormat.format(Date(start.at)), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
        }
        turn.events.forEach { EventRow(it) }
    }
}

@Composable
private fun EventRow(e: Audit.Event) {
    val p = Nekko.palette
    val (text, detail) = describe(e)
    val mark = when (Audit.tone(e)) {
        Audit.Tone.NEUTRAL -> p.inkFaint
        Audit.Tone.GOOD -> p.success
        Audit.Tone.WARN -> p.warning
        Audit.Tone.BAD -> p.danger
    }
    Row(Modifier.fillMaxWidth().padding(start = 4.dp).testTag("chat.audit.event"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.padding(top = 6.dp).size(8.dp).background(mark, CircleShape))
        Column(Modifier.weight(1f)) {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = p.ink)
            if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        Text(timeFormat.format(Date(e.at)), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
    }
}

@Composable
private fun severity(s: String?): String? = when (s) {
    null, "" -> null
    "high" -> stringResource(R.string.chat_audit_severity_high)
    "medium" -> stringResource(R.string.chat_audit_severity_medium)
    "low" -> stringResource(R.string.chat_audit_severity_low)
    else -> s
}

/** Who answered, in words, as on the desktop (`describeBy`). */
@Composable
internal fun describeBy(by: Audit.By?): String {
    if (by == null) return stringResource(R.string.chat_audit_by_nobody)
    val name = by.name
    val id = by.device
    return when (by.via) {
        "this computer" -> stringResource(R.string.chat_audit_by_this_computer)
        "phone" -> when {
            name != null -> stringResource(R.string.chat_audit_by_named_phone, name)
            id != null -> stringResource(R.string.chat_audit_by_phone_id, id)
            else -> stringResource(R.string.chat_audit_by_phone)
        }
        "paired computer" -> when {
            name != null -> stringResource(R.string.chat_audit_by_named_computer, name)
            id != null -> stringResource(R.string.chat_audit_by_computer_id, id)
            else -> stringResource(R.string.chat_audit_by_computer)
        }
        "telegram" -> stringResource(R.string.chat_audit_by_telegram)
        "yolo" -> stringResource(R.string.chat_audit_by_yolo)
        "workflow policy" -> stringResource(R.string.chat_audit_by_workflow)
        "mode" -> stringResource(R.string.chat_audit_by_mode)
        "rule" -> stringResource(R.string.chat_audit_by_rule)
        else -> stringResource(R.string.chat_audit_by_other, by.via)
    }
}

/** One event as a line and its quieter detail, as on the desktop (`describeEvent`). */
@Composable
private fun describe(e: Audit.Event): Pair<String, String> = when (e) {
    is Audit.Turn -> "" to ""
    is Audit.Tool -> {
        val recipients = when (e.recipients) {
            0 -> null
            1 -> stringResource(R.string.chat_audit_recipients_one)
            else -> stringResource(R.string.chat_audit_recipients_other, e.recipients)
        }
        val detail = (e.touched + listOfNotNull(recipients, e.ms?.let { "$it ms" })).joinToString(" · ")
        stringResource(if (e.isError) R.string.chat_audit_failed else R.string.chat_audit_ran, e.tool) to detail
    }
    is Audit.Approval -> {
        val tool = e.tool ?: stringResource(R.string.chat_audit_a_tool)
        val what = severity(e.severity)?.let { "$tool ($it)" } ?: tool
        when (e.answer) {
            Audit.Answer.APPROVED -> stringResource(R.string.chat_audit_asked_approved, what) to describeBy(e.by)
            Audit.Answer.DENIED -> stringResource(R.string.chat_audit_asked_denied, what) to describeBy(e.by)
            Audit.Answer.UNANSWERED -> stringResource(R.string.chat_audit_asked_unanswered, what) to stringResource(R.string.chat_audit_unanswered_detail)
        }
    }
    is Audit.Permission -> when (e.decision) {
        "approved" -> stringResource(R.string.chat_audit_permission_approved, e.tool)
        "denied" -> stringResource(R.string.chat_audit_permission_denied, e.tool)
        else -> stringResource(R.string.chat_audit_permission_other, e.tool, e.decision)
    } to describeBy(e.by)
    is Audit.Taint -> stringResource(R.string.chat_audit_taint) to stringResource(R.string.chat_audit_taint_detail, e.by)
    is Audit.Redactions -> stringResource(R.string.chat_audit_redactions) to
        e.counts.joinToString(", ") { (kind, n) -> "$n ${kind.lowercase().replace('_', ' ')}" }
}
