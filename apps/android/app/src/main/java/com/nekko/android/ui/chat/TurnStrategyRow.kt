package com.nekko.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.TurnStrategy

/** A turn’s admitted strategy, not an activity indicator. */
@Composable
internal fun TurnStrategyRow(strategy: TurnStrategy) {
    val p = Nekko.palette
    val summary = when (strategy.orchestration) {
        TurnStrategy.Orchestration.EXTERNAL -> stringResource(R.string.strategy_external)
        else -> {
            val tools = stringResource(when (strategy.tools) {
                TurnStrategy.Tools.CODE -> R.string.strategy_code
                TurnStrategy.Tools.LIST -> R.string.strategy_list
                TurnStrategy.Tools.NONE -> R.string.strategy_none
                TurnStrategy.Tools.CLAUDE_CODE -> R.string.strategy_claude_code
            })
            val mode = stringResource(when (strategy.orchestration) {
                TurnStrategy.Orchestration.DIRECT -> R.string.strategy_direct
                TurnStrategy.Orchestration.COORDINATOR -> R.string.strategy_coordinator
                TurnStrategy.Orchestration.WORKER -> R.string.strategy_worker
                TurnStrategy.Orchestration.EXTERNAL -> R.string.strategy_external
            })
            "$tools · $mode"
        }
    }
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(R.string.strategy_heading), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, color = p.inkSoft)
        Text(summary, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        strategy.modelId?.let { Text(stringResource(R.string.strategy_model, it), style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        val worker = strategy.subagentModelId ?: if (strategy.subagentsDeferred) stringResource(R.string.strategy_deferred) else null
        worker?.let { Text(stringResource(R.string.strategy_subagent_model, it), style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
    }
}
