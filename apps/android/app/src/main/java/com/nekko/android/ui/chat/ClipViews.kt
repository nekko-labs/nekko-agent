package com.nekko.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.AgentRows
import com.nekko.protocol.AgentWatch
import com.nekko.protocol.AskAnswer
import com.nekko.protocol.AskRequest
import com.nekko.protocol.ClipOffer
import com.nekko.protocol.ClipPicker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The clip an agent is making, above the message box (#2973): "Making a clip", its stage and
 * "in progress", with **Cancel clip**. A clip is no timed wake-up, so it shows no countdown.
 * Timer and PR watches keep their rows in the transcript.
 */
@Composable
fun ClipWatchChips(watches: List<AgentWatch>, onCancel: suspend (String) -> Unit) {
    val clips = watches.filter { it.kind == AgentWatch.Kind.CLIP && it.status == AgentWatch.Status.ACTIVE }
    if (clips.isEmpty()) return
    Column(Modifier.padding(horizontal = 20.dp, vertical = 4.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        clips.forEach { ClipWatchChip(it, onCancel) }
    }
}

@Composable
private fun ClipWatchChip(clip: AgentWatch, onCancel: suspend (String) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val resources = LocalResources.current
    var busy by remember(clip.id) { mutableStateOf(false) }
    var error by remember(clip.id) { mutableStateOf<String?>(null) }
    val call = AgentRows.WatchCall(AgentRows.WatchCall.Action.CREATE, AgentWatch.Kind.CLIP, null, null, "", clip.id)
    val clock = AgentRows.watchClock(call, clip, System.currentTimeMillis())
    val line = listOfNotNull(AgentRows.watchName(clip), AgentRows.clipProgress(clip), clock?.text).joinToString(" · ")
    Column {
        Row(
            Modifier.fillMaxWidth().testTag("chat.clip.chip").semantics { contentDescription = listOfNotNull(line, clock?.detail).joinToString(". ") },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(line, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.weight(1f))
            TextButton(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            onCancel(clip.id)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = resources.getString(R.string.chat_clip_cancel_failed, e.message ?: resources.getString(R.string.chat_reach_failed))
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy,
                modifier = Modifier.heightIn(min = 48.dp).testTag("chat.clip.cancel"),
            ) { Text(stringResource(if (busy) R.string.chat_clip_cancelling else R.string.chat_clip_cancel_watch)) }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
    }
}

/**
 * A paid cloud clip's choice and confirmation in one card (#3038): length, audio and resolution
 * side by side, a Total that follows each pick, what leaves the computer, **Cancel** and
 * **Make clip · $2.40**. It answers with each pick and the total, which the computer takes as
 * the approval when it matches the price. Cancel answers nothing, so nothing starts or is charged.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ClipPickerCard(request: AskRequest, clip: ClipOffer, onAnswer: suspend (List<AskAnswer>) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val resources = LocalResources.current
    var picks by remember(request.callId) { mutableStateOf(ClipPicker.suggestedPicks(request)) }
    var busy by remember(request.callId) { mutableStateOf(false) }
    var error by remember(request.callId) { mutableStateOf<String?>(null) }
    val total = ClipPicker.total(request, picks)
    val send = { answers: List<AskAnswer> ->
        busy = true
        error = null
        scope.launch {
            try {
                onAnswer(answers)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: resources.getString(R.string.chat_reach_failed)
            } finally {
                busy = false
            }
        }
        Unit
    }
    InputCardFrame(p.accent) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.chat_clip_title, clip.model), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
            Text(stringResource(R.string.chat_clip_via, clip.via, clip.via), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            request.questions.forEach { q ->
                Column {
                    Text(q.header.ifBlank { q.question }, style = MaterialTheme.typography.labelMedium, color = p.inkSoft)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        q.options.forEach { o ->
                            val on = picks[q.id] == o.label
                            FilterChip(
                                selected = on,
                                enabled = !busy,
                                onClick = { picks = picks + (q.id to o.label) },
                                leadingIcon = { if (on) Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                label = { Text(o.label) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = p.accent,
                                    selectedLabelColor = p.accentInk,
                                    selectedLeadingIconColor = p.accentInk,
                                ),
                                modifier = Modifier.heightIn(min = 48.dp).testTag("chat.clip.option.${o.label}"),
                            )
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().testTag("chat.clip.total"), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.chat_clip_total), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            Text(
                total?.let { ClipPicker.usd(it) } ?: stringResource(R.string.chat_clip_not_priced),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = p.ink,
            )
        }
        Text(
            stringResource(if (clip.sendsPicture) R.string.chat_clip_warning_picture else R.string.chat_clip_warning_prompt, clip.via),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
        )
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { send(emptyList()) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).testTag("chat.clip.skip")) {
                Text(stringResource(R.string.chat_clip_cancel))
            }
            Button(
                onClick = { total?.let { send(ClipPicker.answers(request, picks, it)) } },
                enabled = !busy && total != null,
                modifier = Modifier.heightIn(min = 48.dp).testTag("chat.clip.make"),
            ) {
                Text(
                    when {
                        busy -> stringResource(R.string.chat_clip_starting)
                        total == null -> stringResource(R.string.chat_clip_make)
                        else -> stringResource(R.string.chat_clip_make_price, ClipPicker.usd(total))
                    },
                )
            }
        }
    }
}
