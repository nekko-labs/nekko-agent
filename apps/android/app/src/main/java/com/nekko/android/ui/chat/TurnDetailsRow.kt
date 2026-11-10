package com.nekko.android.ui.chat

import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.chat.TurnSteps
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.TurnDetails
import com.nekko.protocol.TurnStats

/** The effort's word in the phone's language, as the effort picker names it. */
@StringRes
private fun effortName(effort: String): Int = when (effort) {
    "low" -> R.string.effort_low
    "medium" -> R.string.effort_medium
    "normal" -> R.string.effort_normal
    "high" -> R.string.effort_high
    "xhigh" -> R.string.effort_xhigh
    else -> R.string.effort_max
}

/** The line's parts: model · provider · effort · in · out · speed · time (the iPhone's `TurnDetails.parts`). */
@Composable
private fun parts(s: TurnStats): List<String> = buildList {
    add(s.modelId)
    add(s.providerId)
    s.effort?.let { add(stringResource(R.string.turn_effort, stringResource(effortName(it)))) }
    add(stringResource(R.string.turn_in, TurnDetails.tokens(s.allInput)))
    add(stringResource(R.string.turn_out, TurnDetails.tokens(s.outputTokens)))
    s.tokensPerSecond?.let { add(stringResource(R.string.turn_rate, TurnDetails.rate(it))) }
    add(TurnSteps.duration(s.wallMs.toLong()))
}

/**
 * A finished reply's closing line (#2112, the iPhone's TurnDetailsView, #1911): a check and Done
 * when the computer recorded that the turn completed, then the model, effort, tokens, speed and
 * time on one wrapping line. A tap opens the breakdown underneath (cache, decode and total time,
 * model calls, how it ended) and closes it again.
 */
@Composable
fun TurnDetailsRow(details: TurnDetails, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val s = details.stats
    var open by rememberSaveable(details.id) { mutableStateOf(false) }
    val line = parts(s)
    val done = stringResource(R.string.turn_done)
    val toggle = stringResource(if (open) R.string.turn_hide_details else R.string.turn_show_details)
    Column(
        modifier
            .fillMaxWidth()
            .clickable(onClickLabel = toggle, role = Role.Button) { open = !open }
            .padding(vertical = 4.dp)
            .heightIn(min = 32.dp)
            .testTag("turn.details.${details.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Column(
            Modifier.semantics(mergeDescendants = true) {
                contentDescription = (if (details.successful) "$done. " else "") + line.joinToString(", ")
                stateDescription = toggle
            },
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (details.successful) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = p.success, modifier = Modifier.size(14.dp))
                Text(done, style = MaterialTheme.typography.labelSmall, color = p.success)
            }
            Text(line.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = p.inkFaint, modifier = Modifier.clearAndSetSemantics { })
        }
        AnimatedVisibility(open) {
            Column(Modifier.padding(top = 2.dp).testTag("turn.breakdown"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                @Composable fun row(@StringRes label: Int, value: String) = Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(label), style = MaterialTheme.typography.labelSmall, color = p.inkSoft, modifier = Modifier.widthIn(min = 120.dp))
                    Text(value, style = MaterialTheme.typography.labelSmall, color = p.ink)
                }
                row(R.string.turn_detail_model, "${s.modelId} · ${s.providerId}")
                s.effort?.let { row(R.string.turn_detail_effort, stringResource(effortName(it))) }
                row(R.string.turn_detail_input, TurnDetails.tokens(s.inputTokens))
                s.cacheReadTokens?.takeIf { it > 0 }?.let { row(R.string.turn_detail_cache_read, TurnDetails.tokens(it)) }
                s.cacheWriteTokens?.takeIf { it > 0 }?.let { row(R.string.turn_detail_cache_write, TurnDetails.tokens(it)) }
                row(R.string.turn_detail_output, TurnDetails.tokens(s.outputTokens))
                s.tokensPerSecond?.let { row(R.string.turn_detail_speed, stringResource(R.string.turn_rate, TurnDetails.rate(it))) }
                s.outputMs?.takeIf { it > 0 }?.let { row(R.string.turn_detail_writing, TurnSteps.duration(it.toLong())) }
                row(R.string.turn_detail_total, TurnSteps.duration(s.wallMs.toLong()))
                row(R.string.turn_detail_calls, "%.0f".format(s.calls))
                row(
                    R.string.turn_detail_ended,
                    stringResource(
                        when {
                            details.successful -> R.string.turn_stop_complete
                            s.stop == "complete" -> R.string.turn_stop_interrupted
                            s.stop == "loop" -> R.string.turn_stop_loop
                            s.stop == "runaway" -> R.string.turn_stop_runaway
                            else -> R.string.turn_stop_unknown
                        },
                    ),
                )
            }
        }
    }
}
