package com.nekko.android.ui.screens

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Button
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Connectors
import com.nekko.android.data.PullRequests
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.DraftStore
import com.nekko.protocol.PhonePullRequest
import com.nekko.protocol.PhoneRepo
import com.nekko.protocol.PullRequest
import com.nekko.protocol.PullRequestPlace
import com.nekko.protocol.PullRequestPrompt
import com.nekko.protocol.WorkspaceFolder
import kotlinx.coroutines.launch

/** Every paired computer's folders, by computer: the active one's and those its other links listed. */
private fun places(repo: ComputersRepository): List<Pair<String, List<WorkspaceFolder>>> {
    val s = repo.state.value
    return s.computers.map { c -> c.id to (if (c.id == s.activeId) s.workspaces else s.peers[c.id]?.workspaces.orEmpty()) }
}

/**
 * Pull requests from this phone's git provider (#2109, the iPhone's PullRequestsView, decision 0058):
 * Mine (to review, opened by me, assigned) and Projects (the repositories the paired computers'
 * folders hold, plus pinned ones). Each has one-tap prompts that open New chat with the words
 * filled in, on the computer that holds the repository; nothing is sent until Start.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullRequestsScreen(
    repo: ComputersRepository,
    connectors: Connectors,
    model: PullRequests,
    onBack: () -> Unit,
    onConnectors: () -> Unit,
    /** New chat with [text] staged on the computer that holds the repository. */
    onStartChat: (text: String) -> Unit,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val c by connectors.state.collectAsStateWithLifecycle()
    val s by model.state.collectAsStateWithLifecycle()
    var scopeName by rememberSaveable { mutableStateOf(PullRequests.Scope.MINE.name) }
    val current = PullRequests.Scope.valueOf(scopeName)
    var filter by remember { mutableStateOf<PhonePullRequest.Role?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var opened by remember { mutableStateOf<PhonePullRequest?>(null) }
    var pinning by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    val provider = c.gitProvider
    val folders = { places(repo).flatMap { it.second } }
    fun load(force: Boolean = false) = scope.launch { if (force || current !in model.state.value.loaded) model.load(current, folders()) }
    LaunchedEffect(Unit) { connectors.load() }
    LaunchedEffect(current, provider?.kind) { if (provider != null) load(force = true) }
    val noComputer = stringResource(R.string.prs_pair_first)
    val start: (PullRequestPrompt, PhonePullRequest) -> Unit = { prompt, pr ->
        opened = null
        val match = PullRequestPlace.find(pr.repo, places(repo), repo.state.value.activeId)
        if (match == null) notice = noComputer else {
            if (match.computer != repo.state.value.activeId) scope.launch { runCatching { repo.connect(match.computer) } }
            // New chat's draft gets the folder; the words come as text to edit before Start.
            match.folder?.let { f -> repo.drafts.set(DraftStore.NEW_CHAT, repo.drafts.draft(DraftStore.NEW_CHAT).copy(workspaceId = f)) }
            onStartChat(prompt.text(pr))
        }
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.prs_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.chats_back)) } },
                actions = {
                    var open by remember { mutableStateOf(false) }
                    Box {
                        val label = stringResource(R.string.prs_options)
                        IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = label }.testTag("pullRequests.menu")) { Icon(Icons.Outlined.MoreVert, null) }
                        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = p.surface) {
                            if (c.git.size > 1) c.git.forEach { g ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.prs_from, g.label)) },
                                    trailingIcon = { if (g.kind == provider?.kind) Icon(Icons.Outlined.Check, null, tint = p.accent) },
                                    onClick = { open = false; scope.launch { connectors.selectGit(g.kind) } },
                                )
                            }
                            if (current == PullRequests.Scope.PROJECTS && provider != null) DropdownMenuItem(text = { Text(stringResource(R.string.prs_add_repo)) }, leadingIcon = { Icon(Icons.Outlined.PushPin, null) }, onClick = { open = false; pinning = true })
                            DropdownMenuItem(text = { Text(stringResource(R.string.connectors_title)) }, onClick = { open = false; onConnectors() })
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (provider == null) {
            Column(Modifier.fillMaxSize().padding(padding).padding(20.dp).testTag("pullRequests.view"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.prs_connect_title), style = MaterialTheme.typography.titleMedium, color = p.ink)
                Text(stringResource(R.string.prs_connect_text), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                Button(onClick = onConnectors, modifier = Modifier.heightIn(min = 48.dp).testTag("pullRequests.connect")) { Text(stringResource(R.string.prs_open_connectors)) }
            }
            return@Scaffold
        }
        val list = run {
            var l = if (current == PullRequests.Scope.MINE) s.mine else s.projects
            if (current == PullRequests.Scope.MINE) filter?.let { f -> l = l.filter { f in it.roles } }
            val q = query.trim().lowercase()
            if (q.isNotEmpty()) l = l.filter { pr -> listOf(pr.title, pr.repo, pr.author.orEmpty(), "#${pr.number}").any { it.lowercase().contains(q) } }
            l
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp).testTag("pullRequests.view"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag("pullRequests.scope")) {
                    PullRequests.Scope.entries.forEachIndexed { i, sc ->
                        SegmentedButton(
                            selected = current == sc, onClick = { scopeName = sc.name },
                            shape = SegmentedButtonDefaults.itemShape(i, 2),
                        ) { Text(stringResource(if (sc == PullRequests.Scope.MINE) R.string.prs_mine else R.string.prs_projects)) }
                    }
                }
            }
            if (current == PullRequests.Scope.MINE) item {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RoleChip(stringResource(R.string.prs_all), s.mine.size, filter == null) { filter = null }
                    listOf(PhonePullRequest.Role.REVIEW_REQUESTED, PhonePullRequest.Role.AUTHORED, PhonePullRequest.Role.ASSIGNED).forEach { r ->
                        RoleChip(roleName(r), s.mine.count { r in it.roles }, filter == r) { filter = r }
                    }
                }
            }
            item {
                OutlinedTextField(query, { query = it }, placeholder = { Text(stringResource(R.string.prs_filter)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text(provider.account?.let { stringResource(R.string.prs_from_as, provider.label, it) } ?: stringResource(R.string.prs_from, provider.label), style = MaterialTheme.typography.labelSmall, color = p.inkFaint, modifier = Modifier.padding(top = 4.dp))
            }
            s.error?.let { e -> item { Text(e, style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.testTag("pullRequests.error")) } }
            if (s.loading && current !in s.loaded) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            if (current == PullRequests.Scope.PROJECTS) {
                if (PullRequests.Scope.PROJECTS in s.loaded && s.projectRepos.isEmpty()) item {
                    Text(stringResource(R.string.prs_no_repos), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                    TextButton(onClick = { pinning = true }) { Text(stringResource(R.string.prs_add_repo)) }
                }
                s.projectRepos.forEach { r ->
                    item(key = "repo:${r.fullName}") {
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(r.fullName, style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.weight(1f))
                            if (r in s.pinned) TextButton(onClick = { scope.launch { model.unpin(r) } }) { Text(stringResource(R.string.prs_unpin)) }
                        }
                    }
                    val rows = list.filter { it.repo.equals(r.fullName, ignoreCase = true) }
                    if (rows.isEmpty()) item(key = "none:${r.fullName}") { Text(stringResource(R.string.prs_none_open), style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
                    items(rows, key = { "p:${it.url}" }) { pr -> PullRequestRow(pr, showRepo = false) { opened = pr } }
                }
            } else if (PullRequests.Scope.MINE in s.loaded && list.isEmpty() && s.error == null) {
                item { Text(stringResource(if (query.isBlank()) R.string.prs_nothing_mine else R.string.prs_no_match), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft) }
            } else {
                items(list, key = { it.url }) { pr -> PullRequestRow(pr, showRepo = true) { opened = pr } }
            }
            item { Spacer(Modifier.size(24.dp)) }
        }
    }
    opened?.let { pr -> PullRequestSheet(pr, repo, onDismiss = { opened = null }, start = start) }
    if (pinning) PinRepoSheet(model, s, onDone = { pinning = false; load(force = true) })
    notice?.let { n ->
        androidx.compose.material3.AlertDialog(onDismissRequest = { notice = null }, text = { Text(n) }, confirmButton = { TextButton(onClick = { notice = null }) { Text("OK") } })
    }
}

@Composable
private fun roleName(r: PhonePullRequest.Role) = stringResource(when (r) {
    PhonePullRequest.Role.REVIEW_REQUESTED -> R.string.prs_to_review
    PhonePullRequest.Role.AUTHORED -> R.string.prs_opened_by_me
    PhonePullRequest.Role.ASSIGNED -> R.string.prs_assigned
    PhonePullRequest.Role.PROJECT -> R.string.prs_projects
})

@Composable
private fun RoleChip(title: String, count: Int, on: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Text(
        "$title $count",
        style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
        color = if (on) p.accentInk else p.ink,
        modifier = Modifier.heightIn(min = 40.dp).clip(CircleShape).background(if (on) p.accent else p.surface).border(1.dp, if (on) Color.Transparent else p.line, CircleShape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp),
    )
}

/** One pull request: repository and number, title, and what state it is in. */
@Composable
private fun PullRequestRow(pr: PhonePullRequest, showRepo: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(androidx.compose.foundation.shape.RoundedCornerShape(12.dp)).background(p.surface).clickable(onClick = onClick).padding(12.dp).testTag("pullRequests.row"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (showRepo) "${pr.repo} #${pr.number}" else "#${pr.number}", style = MaterialTheme.typography.labelMedium, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            pr.updatedAt?.let { Text(android.text.format.DateUtils.getRelativeTimeSpanString(minOf(it, System.currentTimeMillis())).toString(), style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
        }
        Text(pr.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (pr.isDraft) Badge(stringResource(R.string.prs_draft), p.inkSoft)
            when (pr.checks) {
                PullRequest.Checks.PASSING -> CheckIcon(Icons.Filled.CheckCircle, p.success, stringResource(R.string.prs_checks_passing))
                PullRequest.Checks.FAILING -> CheckIcon(Icons.Filled.Cancel, p.danger, stringResource(R.string.prs_checks_failing))
                PullRequest.Checks.PENDING -> CheckIcon(Icons.Filled.Schedule, p.warning, stringResource(R.string.prs_checks_running))
                PullRequest.Checks.NONE -> Unit
            }
            when (pr.review) {
                PhonePullRequest.Review.APPROVED -> Badge(stringResource(R.string.prs_approved), p.success)
                PhonePullRequest.Review.CHANGES_REQUESTED -> Badge(stringResource(R.string.prs_changes_requested), p.danger)
                else -> Unit
            }
            if (PhonePullRequest.Role.REVIEW_REQUESTED in pr.roles) Badge(stringResource(R.string.prs_to_review), p.accent)
            Spacer(Modifier.weight(1f))
            pr.author?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = p.inkFaint, maxLines = 1) }
        }
    }
}

@Composable
private fun CheckIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, label: String) =
    Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(16.dp))

@Composable
private fun Badge(text: String, color: Color) =
    Text(text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = color,
        modifier = Modifier.clip(CircleShape).background(color.copy(alpha = 0.12f)).padding(horizontal = 6.dp, vertical = 2.dp))

/** A pull request's sheet: what it is, and the prompts to start a chat about it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PullRequestSheet(pr: PhonePullRequest, repo: ComputersRepository, onDismiss: () -> Unit, start: (PullRequestPrompt, PhonePullRequest) -> Unit) {
    val p = Nekko.palette
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    val s by repo.state.collectAsStateWithLifecycle()
    val match = PullRequestPlace.find(pr.repo, places(repo), s.activeId)
    val name = match?.let { m -> s.computers.firstOrNull { it.id == m.computer }?.name }
    val folder = match?.folder?.let { f -> places(repo).firstOrNull { it.first == match.computer }?.second?.firstOrNull { it.id == f }?.name }
    val place = when {
        name == null -> stringResource(R.string.prs_place_none)
        folder != null -> stringResource(R.string.prs_place_folder, name, folder)
        else -> stringResource(R.string.prs_place_no_folder, name, pr.repoName)
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PullRequestRow(pr, showRepo = true) {}
            if (pr.head != null && pr.base != null) {
                Text(stringResource(R.string.prs_branches, pr.head!!, pr.base!!), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(vertical = 6.dp))
            }
            Text(stringResource(R.string.prs_start_chat).uppercase(), style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp))
            PullRequestPrompt.entries.filter { it.fits(pr) }.forEach { prompt ->
                Text(
                    promptLabel(prompt), style = MaterialTheme.typography.bodyLarge, color = p.ink,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { start(prompt, pr) }.padding(vertical = 12.dp).testTag("pullRequest.prompt.${prompt.name.lowercase()}"),
                )
            }
            Text(place, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            HorizontalDivider(color = p.line, modifier = Modifier.padding(vertical = 8.dp))
            TextButton(onClick = { runCatching { uri.openUri(pr.url) } }) { Text(stringResource(R.string.prs_open_browser)) }
            TextButton(onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, pr.url), null))
            }) { Text(stringResource(R.string.prs_share_link)) }
        }
    }
}

@Composable
private fun promptLabel(p: PullRequestPrompt) = stringResource(when (p) {
    PullRequestPrompt.REVIEW -> R.string.prs_prompt_review
    PullRequestPrompt.FIX_CHECKS -> R.string.prs_prompt_fix_checks
    PullRequestPrompt.ADDRESS_COMMENTS -> R.string.prs_prompt_address_comments
    PullRequestPrompt.SUMMARIZE -> R.string.prs_prompt_summarize
    PullRequestPrompt.UPDATE -> R.string.prs_prompt_update
    PullRequestPrompt.ASK -> R.string.prs_prompt_ask
})

/** Add a repository to Projects, from the ones the provider lists for the person. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PinRepoSheet(model: PullRequests, s: PullRequests.State, onDone: () -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDone, containerColor = p.paper) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.prs_add_repo), style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.weight(1f))
                TextButton(onClick = onDone) { Text(stringResource(R.string.prs_done)) }
            }
            OutlinedTextField(query, { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (s.repos.isEmpty()) Text(stringResource(R.string.prs_no_repos_listed), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp))
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(s.repos.filter { query.isBlank() || it.fullName.lowercase().contains(query.lowercase()) }, key = { it.fullName }) { r ->
                    val fromFolder = r in s.projectRepos && r !in s.pinned
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .clickable(enabled = !fromFolder) { scope.launch { if (r in s.pinned) model.unpin(r) else model.pin(r) } },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(r.fullName, color = if (fromFolder) p.inkFaint else p.ink, modifier = Modifier.weight(1f))
                        if (r in s.pinned || r in s.projectRepos) Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.prs_in_projects), tint = p.accent)
                    }
                }
            }
        }
    }
}
