package com.nekko.android.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.LocalOffer
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.TextButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import com.nekko.android.data.PlanDisplay
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.AgentPlan
import com.nekko.protocol.PlanStep
import com.nekko.protocol.PlanStepLinks
import com.nekko.protocol.ProjectLink
import com.nekko.protocol.PullRequest
import com.nekko.protocol.SessionSummary

/**
 * The agent's plan as the desktop and the iPhone draw it (#2115, `PlanSheet.tsx`, PlanSheet.swift):
 * a sheet tucked behind the composer's top edge, with a touch of accent in its surface.
 *
 * Folded (the default) it is one or two lines: the step being worked (its mark, loop kind, title,
 * pass and "2 of 4") and a row of chips for it. Tapping it opens the whole plan, every step with
 * its detail and chips; finished steps squeeze to their title and open or fold when tapped, except
 * the last one with results for the user (a PR, a check's evidence), which starts open. Chips are
 * placed by the app, not the model: sub-agents, PRs and task links. A step's check shows on its bullet.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PlanSheet(plan: ChatViewModel.PlanUi, mode: PlanDisplay, onMode: (PlanDisplay) -> Unit, showPrs: Boolean, onOpenChat: (String) -> Unit) {
    val p = Nekko.palette
    if (mode == PlanDisplay.HIDDEN) return
    var open by remember(mode) { mutableStateOf(mode == PlanDisplay.FULL) }
    var completedOpen by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val tapped = remember { mutableStateMapOf<String, Boolean>() }
    val steps = plan.plan
    val sheetLabel = stringResource(R.string.plan_sheet)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp))
            .background(p.surface2)
            .background(p.accent.copy(alpha = 0.08f))
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .semantics { contentDescription = sheetLabel }
            .testTag("chat.planSheet"),
    ) {
        val compact = !open && !plan.current.squeezed
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
            if (compact) Folded(plan, showPrs, onOpenChat) { open = true }
            else {
            val done = AgentPlan.finished(steps)
            val openLabel = stringResource(R.string.plan_open_label, done, steps.size)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable(role = Role.Button) { open = !open }
                    .semantics(mergeDescendants = true) { contentDescription = openLabel }.testTag("chat.planOpen"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(stringResource(R.string.plan_title), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = p.inkSoft)
                Text(stringResource(R.string.plan_done_of, done, steps.size), style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.weight(1f))
                Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(18.dp))
            }
            }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.Settings, stringResource(R.string.plan_display_configure), modifier = Modifier.size(18.dp)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    PlanDisplay.entries.forEach { option -> DropdownMenuItem(text = { Text(stringResource(option.label)) }, onClick = { menu = false; open = option == PlanDisplay.FULL; onMode(option) }) }
                }
            }
        }
            val opened = AgentPlan.openByDefault(steps, plan.links)
            Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState())) {
                val unfinished = steps.filterNot { it.squeezed }
                val visible = if (compact) unfinished.filter { it.id != plan.current.id }.sortedBy { it.status != PlanStep.Status.ACTIVE }.take(if (mode == PlanDisplay.ONE) 0 else 2) else unfinished
                val completed = steps.filter { it.squeezed }
                @Composable fun StepRow(step: PlanStep) {
                    val own = plan.links[step.id]
                    val kids = own?.subagents.orEmpty().mapNotNull { id -> plan.children.firstOrNull { it.id == id } }
                    val prs = if (showPrs) own?.prs.orEmpty() else emptyList()
                    val chips = prs.isNotEmpty() || own?.projects?.isNotEmpty() == true || kids.isNotEmpty()
                    val more = step.detail != null || chips
                    val shown = !step.squeezed || (tapped[step.id] ?: (step.id == opened))
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .then(if (step.squeezed && more) Modifier.clickable { tapped[step.id] = !shown } else Modifier)
                            .padding(vertical = 4.dp)
                            .testTag("chat.planStep.${step.id}"),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        StepMark(step, plan.paused)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                // The loop kind sits in a fixed column, as on the desktop.
                                Box(Modifier.width(52.dp)) { step.kind?.let { KindLabel(it, step.status == PlanStep.Status.ACTIVE) } }
                                Text(
                                    step.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    color = if (step.squeezed) p.inkSoft else p.ink,
                                    textDecoration = if (step.status == PlanStep.Status.SKIPPED) TextDecoration.LineThrough else null,
                                    modifier = Modifier.weight(1f),
                                )
                                PassLabel(step)
                            }
                            AnimatedVisibility(more && shown && (!compact || step.squeezed), enter = fadeIn(tween(120)), exit = fadeOut(tween(120))) {
                                Column(Modifier.padding(start = 60.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    step.detail?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = p.inkFaint, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                                    if (chips) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        own?.projects.orEmpty().forEach { ProjectChip(it) }
                                        kids.forEach { SubagentChip(it, onOpenChat) }
                                        prs.forEach { PrChip(it, plan.prs) }
                                    }
                                }
                            }
                        }
                    }
                }
                visible.forEach { step -> androidx.compose.runtime.key(step.id) { StepRow(step) } }
                if (completed.isNotEmpty()) {
                    TextButton(onClick = { completedOpen = !completedOpen }, modifier = Modifier.testTag("chat.planCompleted")) {
                        Icon(if (completedOpen) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, modifier = Modifier.size(16.dp))
                        Text(stringResource(R.string.plan_completed_group, completed.size), style = MaterialTheme.typography.labelSmall)
                    }
                    if (completedOpen) completed.forEach { step -> androidx.compose.runtime.key(step.id) { StepRow(step) } }
                }
            }
    }
}

@Composable
private fun Folded(plan: ChatViewModel.PlanUi, showPrs: Boolean, onOpenChat: (String) -> Unit, onOpen: () -> Unit) {
    val p = Nekko.palette
    val steps = plan.plan
    val current = plan.current
    val own = plan.links[current.id]
    // The current step's PRs, else the newest PR the chat opened, so a finished plan still shows where it landed.
    val shownPrs = when {
        !showPrs -> emptyList()
        own?.prs?.isNotEmpty() == true -> own.prs
        else -> steps.flatMap { plan.links[it.id]?.prs.orEmpty() }.takeLast(1)
    }
    // The step's own task links, else the chat's (the first step's), which say what this work is for.
    val projects = own?.projects?.takeIf { it.isNotEmpty() } ?: steps.firstOrNull()?.let { plan.links[it.id]?.projects }.orEmpty()
    val position = steps.indexOfFirst { it.id == current.id } + 1
    val label = stringResource(R.string.plan_folded_label, position, steps.size, current.title)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable(role = Role.Button, onClick = onOpen)
                .semantics(mergeDescendants = true) { contentDescription = label }.testTag("chat.planFolded"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StepMark(current, plan.paused)
            current.kind?.let { KindLabel(it, current.status == PlanStep.Status.ACTIVE) }
            Text(
                current.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (current.status == PlanStep.Status.DONE) p.inkSoft else p.ink, modifier = Modifier.weight(1f),
            )
            PassLabel(current)
            Text(stringResource(R.string.plan_position, position, steps.size), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
            Icon(Icons.Filled.KeyboardArrowUp, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(18.dp))
        }
        if (plan.children.isNotEmpty() || shownPrs.isNotEmpty() || projects.isNotEmpty()) {
            Row(Modifier.padding(start = 20.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (plan.children.isNotEmpty()) SubagentSummary(plan.children)
                shownPrs.forEach { PrChip(it, plan.prs) }
                projects.forEach { ProjectChip(it) }
            }
        }
    }
}

/**
 * The step's bullet (desktop `StepMark`): the agent's reported check outranks the step's status.
 * A sun while a check runs or the step is worked (pause when the reply was stopped), a check when
 * it passed or the step is done, a red X when it failed, a warning when blocked, a ring ahead, a
 * struck ring when skipped. With evidence attached the bullet opens it.
 */
@Composable
private fun StepMark(step: PlanStep, paused: Boolean) {
    val p = Nekko.palette
    val check = step.verification?.status?.takeIf { it != PlanStep.Verification.Status.PENDING && it != PlanStep.Verification.Status.UNKNOWN }
    val running = check == PlanStep.Verification.Status.ACTIVE || (check == null && step.status == PlanStep.Status.ACTIVE)
    val (icon, tint) = when {
        running -> (if (paused) Icons.Filled.Pause else Icons.Outlined.WbSunny) to p.accent
        check == PlanStep.Verification.Status.PASSED || (check == null && step.status == PlanStep.Status.DONE) -> Icons.Filled.Check to p.success
        check == PlanStep.Verification.Status.FAILED -> Icons.Filled.Close to p.danger
        check == PlanStep.Verification.Status.BLOCKED -> Icons.Filled.Warning to p.warning
        step.status == PlanStep.Status.SKIPPED -> Icons.Outlined.Block to p.inkFaint
        else -> Icons.Outlined.Circle to p.inkFaint
    }
    val words = when {
        running && paused -> stringResource(R.string.plan_paused)
        step.verification != null -> step.verification!!.label
        else -> stringResource(when (step.status) {
            PlanStep.Status.ACTIVE -> R.string.plan_working
            PlanStep.Status.DONE -> R.string.plan_done
            PlanStep.Status.SKIPPED -> R.string.plan_skipped
            PlanStep.Status.PENDING -> R.string.plan_pending
        })
    }
    val evidence = step.verification?.safeEvidence
    val uri = LocalUriHandler.current
    val described = if (step.verification == null) words else stringResource(R.string.plan_agent_reported, words)
    val withEvidence = stringResource(R.string.plan_open_evidence, described)
    Box(
        Modifier.size(14.dp)
            .then(if (evidence != null) Modifier.clickable(role = Role.Button) { runCatching { uri.openUri(evidence) } } else Modifier)
            .semantics { contentDescription = if (evidence != null) withEvidence else described },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp)) }
}

/** The step's place in the loop: a small word before its title, in the accent while worked. */
@Composable
private fun KindLabel(kind: PlanStep.Kind, current: Boolean) {
    val p = Nekko.palette
    Text(kind.label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = if (current) p.accent else p.inkSoft, maxLines = 1)
}

/** "Pass 2": Verify sent the work back to this step. */
@Composable
private fun PassLabel(step: PlanStep) {
    val pass = step.pass ?: return
    if (pass < 2) return
    val p = Nekko.palette
    val label = stringResource(R.string.plan_pass_label, pass)
    Row(Modifier.semantics(mergeDescendants = true) { contentDescription = label }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Icon(Icons.Filled.Refresh, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(11.dp))
        Text(stringResource(R.string.plan_pass, pass), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
    }
}

@Composable
private fun Chip(onClick: (() -> Unit)?, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val p = Nekko.palette
    Box(
        Modifier.heightIn(min = 32.dp).then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).then(modifier),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(
            Modifier.height(22.dp).clip(CircleShape).background(p.ink.copy(alpha = 0.07f)).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) { content() }
    }
}

@Composable
private fun ChipText(text: String, color: Color = Nekko.palette.inkSoft, bold: Boolean = false) =
    Text(text, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1, fontWeight = if (bold) FontWeight.SemiBold else null)

@Composable
private fun ChipIcon(icon: ImageVector, tint: Color = Nekko.palette.inkSoft) = Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))

/** The desktop's words (`prChipLabel`): number, state, and CI, with a coloured dot. */
@Composable
private fun PrChip(url: String, prs: List<PullRequest>) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    val pr = prs.firstOrNull { it.url == url }
    val number = pr?.number?.toString() ?: url.substringAfterLast('/')
    val (text, tone) = when {
        pr == null -> "#$number" to p.inkFaint
        pr.state == PullRequest.State.MERGED -> stringResource(R.string.plan_pr_merged, number) to p.accent
        pr.state == PullRequest.State.CLOSED -> stringResource(R.string.plan_pr_closed, number) to p.inkFaint
        else -> {
            val (ci, tone) = when (pr.checks) {
                PullRequest.Checks.FAILING -> stringResource(R.string.plan_ci_failing) to p.danger
                PullRequest.Checks.PASSING -> stringResource(R.string.plan_ci_passing) to p.success
                PullRequest.Checks.PENDING -> stringResource(R.string.plan_ci_running) to p.warning
                PullRequest.Checks.NONE -> stringResource(R.string.plan_ci_none) to p.inkFaint
            }
            "#$number · ${stringResource(if (pr.isDraft) R.string.plan_pr_draft else R.string.plan_pr_open)} · $ci" to tone
        }
    }
    val label = stringResource(R.string.plan_pr_label, text)
    Chip({ runCatching { uri.openUri(url) } }, Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(tone))
        ChipText(text)
    }
}

@Composable
private fun ProjectChip(link: ProjectLink) {
    val uri = LocalUriHandler.current
    Chip({ runCatching { uri.openUri(link.url) } }) {
        ChipIcon(Icons.Outlined.LocalOffer)
        ChipText(link.label)
    }
}

@Composable
private fun SubagentChip(child: SessionSummary, onOpenChat: (String) -> Unit) {
    val p = Nekko.palette
    Chip({ onOpenChat(child.id) }) {
        ChipIcon(Icons.Outlined.Memory)
        ChipText(child.title.ifEmpty { stringResource(R.string.plan_subagent) })
        if (child.running) ChipIcon(Icons.Outlined.WbSunny, p.success) else ChipIcon(Icons.Filled.Check, p.inkFaint)
    }
}

/** Folded, the sub-agents are one chip: how many run and how many are done. */
@Composable
private fun SubagentSummary(children: List<SessionSummary>) {
    val p = Nekko.palette
    val running = children.count { it.running }
    val done = children.size - running
    val label = stringResource(R.string.plan_subagents_label, running, done)
    Chip(null, Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
        ChipText(stringResource(R.string.plan_subagents))
        if (running > 0) { ChipText("$running", p.ink, bold = true); ChipIcon(Icons.Outlined.WbSunny, p.success) }
        if (done > 0) { ChipText("$done", p.ink, bold = true); ChipIcon(Icons.Filled.Check, p.inkFaint) }
    }
}
