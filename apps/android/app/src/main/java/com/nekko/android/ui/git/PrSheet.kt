package com.nekko.android.ui.git

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.MergeType
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.GitPrompt
import com.nekko.protocol.PullRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The chat's pull request above the message box: its number, state and checks. The iPhone's `PrChip`. */
@Composable
fun PrChip(pr: PullRequest, onClick: () -> Unit) {
    val p = Nekko.palette
    val color = when {
        pr.state == PullRequest.State.MERGED -> p.accent
        pr.state == PullRequest.State.CLOSED -> p.inkSoft
        pr.checks == PullRequest.Checks.FAILING -> p.danger
        pr.checks == PullRequest.Checks.PENDING -> p.running
        else -> p.success
    }
    Row(
        Modifier.padding(horizontal = 12.dp, vertical = 4.dp).heightIn(min = 32.dp)
            .clip(RoundedCornerShape(999.dp)).background(color.copy(alpha = 0.14f)).clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .semantics(mergeDescendants = true) { contentDescription = "Pull request ${pr.summary}" }
            .testTag("chat.prChip"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.AutoMirrored.Filled.MergeType, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Text(pr.summary, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * A chat's pull requests, the way into Git, and git steps phrased as prompts:
 * the agent runs them on the computer, so this chat's approvals apply to
 * every command. The iPhone's `PrSheet`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrSheet(
    prs: List<PullRequest>,
    onDismiss: () -> Unit,
    /** Open a pull request's checks, files and actions; null opens Git's status. */
    onGit: (PullRequest?) -> Unit,
    onAsk: suspend (String) -> Unit,
) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper) {
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(if (prs.size == 1) "Pull request" else "Pull requests", style = MaterialTheme.typography.titleMedium, color = p.ink,
                    modifier = Modifier.semantics { heading() })
            }
            if (prs.isEmpty()) item { Text("This chat hasn’t opened a pull request.", color = p.inkSoft) }
            items(prs, key = { it.url }) { pr ->
                Box {
                    Text(pr.title, style = MaterialTheme.typography.titleSmall, color = p.ink)
                    Text(pr.summary, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                    Text("+${pr.additions} −${pr.deletions} in ${if (pr.changedFiles == 1) "1 file" else "${pr.changedFiles} files"}",
                        style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
                    pr.reviewDecision?.takeIf { it.isNotEmpty() }?.let {
                        Text(it.replace('_', ' ').lowercase().replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
                    }
                    HorizontalDivider(color = p.line)
                    Row2(Icons.AutoMirrored.Filled.OpenInNew, "Open on GitHub") { uri.openUri(pr.url) }
                    HorizontalDivider(color = p.line)
                    Row2(Icons.Filled.Checklist, "Checks, files and actions", Modifier.testTag("pr.detail")) { onGit(pr) }
                }
            }
            item {
                Box {
                    Row2(Icons.Filled.AccountTree, "Git: status, commit, push", Modifier.testTag("pr.git")) { onGit(null) }
                }
                Text("Done from this phone, with your fingerprint or screen lock.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint,
                    modifier = Modifier.padding(top = 8.dp, start = 4.dp))
            }
            item {
                Text("ASK THE AGENT", style = MaterialTheme.typography.labelMedium, color = p.inkFaint, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 8.dp).semantics { heading() })
            }
            item {
                Box {
                    GitPrompt.offered(prs).forEachIndexed { i, a ->
                        if (i > 0) HorizontalDivider(color = p.line)
                        val icon = when (a) {
                            GitPrompt.COMMIT -> Icons.Filled.Verified
                            GitPrompt.OPEN_PR -> Icons.AutoMirrored.Filled.MergeType
                            GitPrompt.FIX_CHECKS -> Icons.Filled.Build
                        }
                        Row2(icon, a.label, Modifier.testTag("pr.ask.${a.name.lowercase()}")) {
                            failed = null
                            scope.launch {
                                try {
                                    onAsk(a.text)
                                    onDismiss()
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    failed = e.message ?: "Couldn’t send that."
                                }
                            }
                        }
                    }
                }
                Text("Sent to this chat as a prompt. The agent does the git work on the computer, and asks you before anything that needs approval.",
                    style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
            }
            failed?.let { item { Notice(it, Tone.DANGER) } }
        }
    }
}

@Composable
private fun Box(content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

@Composable
private fun Row2(icon: ImageVector, title: String, modifier: Modifier = Modifier, tint: Color = Nekko.palette.accent, onClick: () -> Unit) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onClick).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Text(title, style = MaterialTheme.typography.bodyLarge, color = Nekko.palette.ink)
    }
}
