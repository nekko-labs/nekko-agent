package com.nekko.android.ui.git

import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.CompareArrows
import androidx.compose.material.icons.automirrored.filled.MergeType
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.RemoveCircleOutline
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.graphics.luminance
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.git.GitController
import com.nekko.android.git.GitState
import com.nekko.android.ui.chat.DiffLine
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.GitBranch
import com.nekko.protocol.GitBranches
import com.nekko.protocol.GitCommit
import com.nekko.protocol.GitCommitDetail
import com.nekko.protocol.GitCompare
import com.nekko.protocol.GitDiff
import com.nekko.protocol.GitFile
import com.nekko.protocol.PhoneChanges
import com.nekko.protocol.PrAction
import com.nekko.protocol.PrCheck
import com.nekko.protocol.PrCheckList
import com.nekko.protocol.PullRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Where the Git screen is: its own small back stack, so it works the same full screen or over a folding phone's pane. */
private sealed interface GitPage {
    data object Status : GitPage
    data class File(val file: GitFile) : GitPage
    data object History : GitPage
    data class Commit(val commit: GitCommit) : GitPage
    data object Branches : GitPage
    data object Compare : GitPage
    data object CreatePr : GitPage
    data class Pr(val pr: PullRequest) : GitPage
    data class PrChecks(val url: String) : GitPage
    data class PrFiles(val url: String) : GitPage
}

/**
 * Git on a chat's folder (AN-30, the iPhone's `GitView`), full screen from
 * the chat's menu: the branch, changed files (staged and not), the commit
 * box, and the way to history, branches, compare and pull requests; or
 * straight at one pull request ([pr], from the chat's pull request chip),
 * where back closes it. Every change asks for
 * the fingerprint, face or screen lock (once per 5 minutes) and shows in this
 * phone's activity on the computer.
 */
@Composable
fun GitDialog(git: GitController, onDismiss: () -> Unit, pr: PullRequest? = null) {
    val stack = remember { mutableStateListOf(if (pr != null) GitPage.Pr(pr) else GitPage.Status) }
    val open: (GitPage) -> Unit = { stack.add(it) }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else onDismiss() }
    LaunchedEffect(git) { if (pr == null) git.load() }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler(onBack = back)
        // The dialog has its own window: its status bar icons follow the app's theme, as the activity's do.
        val view = LocalView.current
        val light = Nekko.palette.paper.luminance() > 0.5f
        LaunchedEffect(light) {
            (view.parent as? DialogWindowProvider)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = light
                    isAppearanceLightNavigationBars = light
                }
            }
        }
        // On an open folding phone the dialog spans both panes: keep the lists a readable width.
        Box(Modifier.fillMaxSize().background(Nekko.palette.paper), contentAlignment = Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
            when (val page = stack.last()) {
                GitPage.Status -> StatusPage(git, onClose = onDismiss, open = open)
                is GitPage.File -> FilePage(page.file, back)
                GitPage.History -> HistoryPage(git, back, open)
                is GitPage.Commit -> CommitPage(git, page.commit, back, open)
                GitPage.Branches -> BranchesPage(git, back)
                GitPage.Compare -> ComparePage(git, back, open)
                GitPage.CreatePr -> CreatePrPage(git, back)
                is GitPage.Pr -> PrPage(git, page.pr, back, close = stack.size == 1, open = open)
                is GitPage.PrChecks -> PrChecksPage(git, page.url, back)
                is GitPage.PrFiles -> PrFilesPage(git, page.url, back, open)
            }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Page(
    title: String,
    onBack: () -> Unit,
    close: Boolean = false,
    actions: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        if (close) Icon(Icons.Filled.Close, contentDescription = "Close")
                        else Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = { actions() },
            )
        },
        content = content,
    )
}

// ---- status ----

@Composable
private fun StatusPage(git: GitController, onClose: () -> Unit, open: (GitPage) -> Unit) {
    val s by git.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var confirmAbort by remember { mutableStateOf(false) }
    Page(
        "Git", onClose, close = true,
        actions = {
            IconButton(onClick = { scope.launch { git.load(refresh = true) } }, enabled = s.busy == null) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val status = s.status
            when {
                s.error != null && status == null -> Empty("Couldn’t read git", s.error!!, "Try again") { scope.launch { git.load(refresh = true) } }
                status != null && !status.repo -> Empty("Not a git repository", "This chat’s folder isn’t in a git repository.")
                !s.loaded -> CircularProgressIndicator(color = Nekko.palette.accent, modifier = Modifier.align(Alignment.Center))
                else -> StatusList(git, s, open, onAbort = { confirmAbort = true })
            }
            if (s.busy != null) {
                Box(Modifier.fillMaxSize().background(Nekko.palette.paper.copy(alpha = 0.5f)).semantics { contentDescription = "Working" }) {
                    CircularProgressIndicator(color = Nekko.palette.accent, modifier = Modifier.align(Alignment.Center))
                }
            }
        }
    }
    if (confirmAbort) {
        AlertDialog(
            onDismissRequest = { confirmAbort = false },
            title = { Text("Abort the merge?") },
            text = { Text("The folder goes back to how it was before the merge started.") },
            confirmButton = {
                TextButton(onClick = { confirmAbort = false; scope.launch { git.abortMerge() } }) { Text("Abort merge", color = Nekko.palette.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmAbort = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun StatusList(git: GitController, s: GitState, open: (GitPage) -> Unit, onAbort: () -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val enabled = s.busy == null
    LazyColumn(Modifier.fillMaxSize().testTag("git.list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "branch") {
            Card {
                val st = s.status
                if (st != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("git.branch")) {
                        Icon(Icons.Filled.AccountTree, contentDescription = null, tint = p.accent, modifier = Modifier.size(18.dp))
                        Column(Modifier.weight(1f)) {
                            Text(st.position, style = MaterialTheme.typography.titleMedium, color = p.ink, fontFamily = FontFamily.Monospace)
                            Text(
                                listOfNotNull(st.drift ?: "Up to date with its upstream", st.worktree?.let { "worktree $it" }).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
                            )
                        }
                    }
                }
                st?.pr?.let { pr ->
                    Link(Icons.AutoMirrored.Filled.MergeType, pr.summary) { open(GitPage.Pr(pr)) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { scope.launch { git.push() } }, enabled = enabled, modifier = Modifier.testTag("git.push")) {
                        Icon(Icons.Filled.Upload, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Push")
                    }
                    if (s.merging) {
                        TextButton(onClick = onAbort, enabled = enabled) { Text("Abort merge", color = p.danger) }
                    }
                }
            }
        }
        s.notice?.let { n ->
            item(key = "notice") { Notice(n.text, if (n.ok) Tone.SUCCESS else Tone.DANGER, Modifier.testTag("git.notice")) }
        }
        files(this, "Staged", s.staged, staged = true, enabled, open,
            toggle = { f -> scope.launch { git.unstage(listOf(f.path)) } }, all = { scope.launch { git.unstageAll() } })
        files(this, "Changes", s.unstaged, staged = false, enabled, open,
            toggle = { f -> scope.launch { git.stage(listOf(f.path)) } }, all = { scope.launch { git.stageAll() } })
        if (!s.hasChanges) {
            item(key = "clean") { Text("No changes to commit.", style = MaterialTheme.typography.bodyMedium, color = p.inkSoft) }
        }
        item(key = "commit") { CommitBox(git, s) }
        item(key = "links") {
            Card {
                Link(Icons.Filled.History, "History") { open(GitPage.History) }
                HorizontalDivider(color = p.line)
                Link(Icons.Filled.AccountTree, "Branches") { open(GitPage.Branches) }
                HorizontalDivider(color = p.line)
                Link(Icons.AutoMirrored.Filled.CompareArrows, "Compare") { open(GitPage.Compare) }
                HorizontalDivider(color = p.line)
                Link(Icons.AutoMirrored.Filled.MergeType, "Open a pull request", Modifier.testTag("git.openPr")) { open(GitPage.CreatePr) }
            }
            Text(
                "Changes from this phone ask for your fingerprint or screen lock, and show in this phone’s activity on the computer.",
                style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp),
            )
        }
    }
}

private fun files(
    scope: LazyListScope,
    title: String,
    diff: GitDiff,
    staged: Boolean,
    enabled: Boolean,
    open: (GitPage) -> Unit,
    toggle: (GitFile) -> Unit,
    all: () -> Unit,
) {
    if (diff.files.isEmpty() && diff.omittedFiles == 0) return
    val action = if (staged) "Unstage" else "Stage"
    scope.item(key = "h-$title") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${title.uppercase()} (${diff.files.size + diff.omittedFiles})",
                style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            TextButton(onClick = all, enabled = enabled, modifier = Modifier.testTag(if (staged) "git.unstageAll" else "git.stageAll")) { Text("$action all") }
        }
    }
    // By position: a conflicted file can be listed twice (once per side of the merge).
    scope.itemsIndexed(diff.files, key = { i, f -> "$title:$i:${f.path}" }) { _, f ->
        val p = Nekko.palette
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
                .clickable { open(GitPage.File(f)) }
                .semantics { customActions = listOf(CustomAccessibilityAction(action) { toggle(f); true }) }
                .padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileRow(f, Modifier.weight(1f).padding(vertical = 10.dp))
            TextButton(onClick = { toggle(f) }, enabled = enabled) { Text(action) }
        }
    }
    if (diff.omittedFiles > 0) {
        scope.item(key = "o-$title") {
            Text(
                "${diff.omittedFiles} more ${if (diff.omittedFiles == 1) "file" else "files"}. See them on your computer.",
                style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint,
            )
        }
    }
    if (diff.hiddenFiles > 0) {
        scope.item(key = "s-$title") {
            Text("Files that may hold secrets are listed but never shown on a phone.", style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint)
        }
    }
}

@Composable
private fun CommitBox(git: GitController, s: GitState) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    Card {
        Text("COMMIT", style = MaterialTheme.typography.labelMedium, color = p.inkFaint, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        OutlinedTextField(
            value = s.message,
            onValueChange = git::setMessage,
            label = { Text("Commit message") },
            minLines = 2,
            maxLines = 8,
            enabled = s.busy == null,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth().testTag("git.message"),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { scope.launch { git.writeMessage() } },
                enabled = s.busy == null && s.staged.files.isNotEmpty(),
                modifier = Modifier.testTag("git.writeMessage"),
            ) {
                Icon(Icons.Filled.AutoAwesome, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Write message")
            }
            Spacer(Modifier.weight(1f))
            Button(onClick = { scope.launch { git.commit() } }, enabled = s.canCommit, modifier = Modifier.testTag("git.commit")) {
                Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Commit")
            }
        }
        val note = when {
            s.messageFromCutDiff -> "The change was too big to show the model in full; check the message."
            s.staged.files.isEmpty() -> "Stage the files to commit first. Write message asks your computer’s model, which uses its tokens."
            else -> null
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
    }
}

// ---- files ----

/** One changed file: its status letter, path and line counts. */
@Composable
private fun FileRow(file: GitFile, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    val color = when (file.status) {
        GitFile.Status.ADDED -> p.success
        GitFile.Status.REMOVED -> p.danger
        GitFile.Status.CONFLICTED -> p.warning
        else -> p.accent
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(file.mark, color = color, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            // Wraps rather than truncates: the path is the only way to tell files apart.
            Text(file.path, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = p.ink)
            file.oldPath?.let { Text("from $it", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = p.inkFaint) }
        }
        when {
            file.hidden -> Icon(Icons.Filled.VisibilityOff, contentDescription = "Not shown on phones", tint = p.inkFaint, modifier = Modifier.size(18.dp))
            !file.binary -> {
                Text("+${file.additions}", style = MaterialTheme.typography.labelMedium, color = p.success)
                Text("−${file.deletions}", style = MaterialTheme.typography.labelMedium, color = p.danger)
            }
        }
    }
}

/** One file's diff, drawn like the Changes sheet. */
@Composable
private fun FilePage(file: GitFile, onBack: () -> Unit) {
    val p = Nekko.palette
    Page(file.path.substringAfterLast('/'), onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { FileRow(file) }
            item {
                when {
                    file.hidden -> Note("May hold secrets, so it isn’t shown on phones.")
                    file.binary -> Note("Not a text file.")
                    file.hunks.isEmpty() -> Note(if (file.truncated) "Too big to show here. See it on your computer." else "No line changes to show.")
                    else -> Column {
                        Hunks(file.hunks)
                        if (file.truncated) Note("Cut short for a phone. See the rest on your computer.", Modifier.padding(top = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun Hunks(hunks: List<PhoneChanges.Hunk>) {
    val p = Nekko.palette
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().background(p.code, shape).border(1.dp, p.line, shape).horizontalScroll(rememberScrollState()).padding(vertical = 6.dp)) {
        hunks.forEachIndexed { i, h ->
            if (i > 0) {
                Text("⋯", fontFamily = FontFamily.Monospace, color = p.inkFaint,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp).semantics { contentDescription = "Unchanged lines skipped" })
            }
            h.lines.forEach { DiffLine(it) }
        }
    }
}

// ---- history and commits ----

/** Newest commits first, fifty at a time. */
@Composable
private fun HistoryPage(git: GitController, onBack: () -> Unit, open: (GitPage) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val commits = remember { mutableStateListOf<GitCommit>() }
    var more by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    suspend fun load(skip: Int) {
        try {
            val page = git.history(limit = 50, skip = skip)
            commits += page
            more = page.size == 50
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
            more = false
        }
        loaded = true
    }
    LaunchedEffect(Unit) { if (commits.isEmpty()) load(0) }
    Page("History", onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(commits, key = { i, c -> "$i:${c.sha}" }) { _, c -> CommitRow(c) { open(GitPage.Commit(c)) } }
            if (more && commits.isNotEmpty()) item { TextButton(onClick = { scope.launch { load(commits.size) } }) { Text("Load more") } }
            error?.let { item { Notice(it, Tone.DANGER) } }
            if (!loaded) item { CircularProgressIndicator(color = p.accent) }
            if (loaded && commits.isEmpty() && error == null) item { Text("No commits yet.", color = p.inkSoft) }
        }
    }
}

@Composable
private fun CommitRow(commit: GitCommit, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(commit.subject.ifEmpty { "(no message)" }, style = MaterialTheme.typography.bodyMedium, color = p.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(commit.short, commit.author.ifEmpty { null }, commit.whenMs?.let { relative(it) }, if (commit.isMerge) "merge" else null).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
            )
        }
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = p.inkFaint)
    }
}

/** One commit: its message and its files. */
@Composable
private fun CommitPage(git: GitController, commit: GitCommit, onBack: () -> Unit, open: (GitPage) -> Unit) {
    val p = Nekko.palette
    var detail by remember { mutableStateOf<GitCommitDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(commit.sha) {
        try { detail = git.commit(commit.sha) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
    }
    Page(commit.short, onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Card {
                    Text(commit.subject, style = MaterialTheme.typography.titleMedium, color = p.ink)
                    detail?.commit?.body?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft) }
                    Text(
                        listOfNotNull(commit.author.ifEmpty { null }, commit.whenMs?.let { absolute(it) }, commit.short).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall, color = p.inkFaint,
                    )
                }
            }
            val d = detail?.diff
            when {
                d != null -> diffFiles(this, d, open)
                error != null -> item { Notice(error!!, Tone.DANGER) }
                else -> item { CircularProgressIndicator(color = p.accent) }
            }
        }
    }
}

private fun diffFiles(scope: LazyListScope, d: GitDiff, open: ((GitPage) -> Unit)?, where: String = "your computer") {
    scope.item(key = "files-h") {
        Text(
            "${d.files.size + d.omittedFiles} FILES · +${d.additions} −${d.deletions}",
            style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 8.dp).semantics { heading() },
        )
    }
    scope.itemsIndexed(d.files, key = { i, f -> "f:$i:${f.path}" }) { _, f ->
        val p = Nekko.palette
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
                .then(if (open != null) Modifier.clickable { open(GitPage.File(f)) } else Modifier).padding(12.dp),
        ) { FileRow(f, Modifier.weight(1f)) }
    }
    if (d.omittedFiles > 0) {
        scope.item(key = "files-o") { Text("${d.omittedFiles} more files. See them on $where.", style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkFaint) }
    }
}

// ---- branches ----

/** Local and remote branches; tap one to switch to it, or make a new one. */
@Composable
private fun BranchesPage(git: GitController, onBack: () -> Unit) {
    val p = Nekko.palette
    val s by git.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var branches by remember { mutableStateOf<GitBranches?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var switching by remember { mutableStateOf<GitBranch?>(null) }
    var naming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    suspend fun load() {
        try { branches = git.branches(); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(Unit) { load() }
    Page(
        "Branches", onBack,
        actions = {
            IconButton(onClick = { newName = ""; naming = true }, enabled = s.busy == null, modifier = Modifier.testTag("git.newBranch")) {
                Icon(Icons.Filled.Add, contentDescription = "New branch")
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val b = branches
            when {
                b != null -> {
                    item { Label("ON THIS COMPUTER") }
                    items(b.local, key = { "l:${it.name}" }) { br -> BranchRow(br, s.busy == null) { switching = br } }
                    if (b.remoteOnly.isNotEmpty()) {
                        item { Label("ON THE REMOTE ONLY") }
                        items(b.remoteOnly, key = { "r:${it.name}" }) { br -> BranchRow(br, s.busy == null) { switching = br } }
                    }
                    if (b.omitted > 0) item { Text("${b.omitted} more branches. See them on your computer.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
                }
                error != null -> item { Notice(error!!, Tone.DANGER) }
                else -> item { CircularProgressIndicator(color = p.accent) }
            }
            s.notice?.let { n -> item { Notice(n.text, if (n.ok) Tone.SUCCESS else Tone.DANGER) } }
        }
    }
    switching?.let { br ->
        AlertDialog(
            onDismissRequest = { switching = null },
            title = { Text("Switch to ${br.localName}?") },
            text = { Text("Git refuses if uncommitted changes would be lost.") },
            confirmButton = { TextButton(onClick = { switching = null; scope.launch { git.switchTo(br.localName); load() } }) { Text("Switch") } },
            dismissButton = { TextButton(onClick = { switching = null }) { Text("Cancel") } },
        )
    }
    if (naming) {
        AlertDialog(
            onDismissRequest = { naming = false },
            title = { Text("New branch") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Starts from the commit you’re on.")
                    OutlinedTextField(
                        newName, { newName = it }, label = { Text("Name") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.testTag("git.branchName"),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val name = newName.trim()
                    naming = false
                    if (name.isNotEmpty()) scope.launch { git.switchTo(name, create = true); load() }
                }, enabled = newName.isNotBlank()) { Text("Create and switch") }
            },
            dismissButton = { TextButton(onClick = { naming = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun BranchRow(br: GitBranch, enabled: Boolean, onSwitch: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled && !br.current, onClick = onSwitch).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(br.name, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = p.ink)
            val detail = listOfNotNull(
                br.subject.ifEmpty { null }, if (br.gone) "upstream gone" else null,
                if (br.ahead > 0) "${br.ahead} ahead" else null, if (br.behind > 0) "${br.behind} behind" else null,
            ).joinToString(" · ")
            if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (br.current) Icon(Icons.Filled.Check, contentDescription = "Current", tint = p.accent)
    }
}

// ---- compare ----

/** What a branch has that another doesn't: commits and files, as a PR would show them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComparePage(git: GitController, onBack: () -> Unit, open: (GitPage) -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var names by remember { mutableStateOf<List<String>>(emptyList()) }
    var base by remember { mutableStateOf("") }
    var head by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<GitCompare?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        val b = try { git.branches() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message; return@LaunchedEffect }
        names = b.local.map { it.name } + b.remote.map { it.name }
        base = b.compareBase
        head = b.current ?: names.firstOrNull().orEmpty()
    }
    Page("Compare", onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Card {
                    BranchPicker("Base", base, names) { base = it }
                    BranchPicker("Compare", head, names) { head = it }
                    Button(
                        onClick = { scope.launch {
                            try { result = git.compare(base, head); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
                        } },
                        enabled = base.isNotEmpty() && head.isNotEmpty() && base != head,
                        modifier = Modifier.testTag("git.compare"),
                    ) { Text("Compare") }
                }
            }
            result?.let { r ->
                item {
                    Text(
                        "${r.ahead} ${if (r.ahead == 1) "commit" else "commits"} on ${r.head} not on ${r.base} · ${r.behind} behind",
                        style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
                    )
                }
                item { Label("COMMITS") }
                itemsIndexed(r.commits, key = { i, c -> "c:$i:${c.sha}" }) { _, c -> CommitRow(c) { open(GitPage.Commit(c)) } }
                diffFiles(this, r.diff, open)
            }
            error?.let { item { Notice(it, Tone.DANGER) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BranchPicker(label: String, value: String, names: List<String>, onPick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = value, onValueChange = {}, readOnly = true, label = { Text(label) }, singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            names.forEach { n ->
                DropdownMenuItem(text = { Text(n, fontFamily = FontFamily.Monospace) }, onClick = { onPick(n); expanded = false })
            }
        }
    }
}

// ---- pull requests ----

/** A pull request from the current branch, pushed first if it isn't yet. */
@Composable
private fun CreatePrPage(git: GitController, onBack: () -> Unit) {
    val p = Nekko.palette
    val s by git.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var base by remember { mutableStateOf("") }
    var draft by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf<String?>(null) }
    var tried by remember { mutableStateOf(false) }
    Page(
        "New pull request", onBack,
        actions = {
            if (opened == null) {
                TextButton(
                    onClick = { scope.launch { tried = true; opened = git.createPr(title, body, base.trim().ifEmpty { null }, draft) } },
                    enabled = title.isNotBlank() && s.busy == null,
                    modifier = Modifier.testTag("pr.create"),
                ) { Text("Open") }
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val url = opened
            if (url != null) {
                item { Notice("Pull request opened.", Tone.SUCCESS) }
                item { Card { Link(Icons.AutoMirrored.Filled.OpenInNew, "Open on GitHub") { uri.openUri(url) } } }
            } else {
                item {
                    Card {
                        OutlinedTextField(title, { title = it }, label = { Text("Title") }, singleLine = true, enabled = s.busy == null,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                            modifier = Modifier.fillMaxWidth().testTag("pr.title"))
                        OutlinedTextField(body, { body = it }, label = { Text("Description") }, minLines = 3, maxLines = 10, enabled = s.busy == null,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences), modifier = Modifier.fillMaxWidth())
                    }
                }
                item {
                    Card {
                        OutlinedTextField(base, { base = it }, label = { Text("Base branch") }, singleLine = true, enabled = s.busy == null,
                            placeholder = { Text("The repository’s default") },
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                            modifier = Modifier.fillMaxWidth())
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Draft", style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
                            Switch(draft, { draft = it }, enabled = s.busy == null)
                        }
                    }
                    Text("Opened from the branch the chat is on. Push it first if it isn’t on GitHub yet.",
                        style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
                }
                val n = s.notice
                if (tried && n != null && !n.ok) item { Notice(n.text, Tone.DANGER) }
                if (s.busy != null) item { CircularProgressIndicator(color = p.accent) }
            }
        }
    }
}

/** A pull request: its checks, its files and the actions a phone may take. */
@Composable
private fun PrPage(git: GitController, pr: PullRequest, onBack: () -> Unit, close: Boolean, open: (GitPage) -> Unit) {
    val p = Nekko.palette
    val s by git.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var current by remember { mutableStateOf(pr) }
    var acted by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<PrAction?>(null) }
    Page("#${current.number}", onBack, close = close) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Card {
                    Text(current.title, style = MaterialTheme.typography.titleMedium, color = p.ink)
                    Text(current.summary, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                    Link(Icons.AutoMirrored.Filled.OpenInNew, "Open on GitHub") { uri.openUri(current.url) }
                }
            }
            item {
                Card {
                    Link(Icons.Filled.Checklist, "Checks", Modifier.testTag("pr.checks")) { open(GitPage.PrChecks(current.url)) }
                    HorizontalDivider(color = p.line)
                    Link(Icons.Filled.Difference, "Files changed", Modifier.testTag("pr.files")) { open(GitPage.PrFiles(current.url)) }
                }
            }
            if (current.actions.isNotEmpty()) {
                item {
                    Card {
                        current.actions.forEachIndexed { i, a ->
                            if (i > 0) HorizontalDivider(color = p.line)
                            TextButton(onClick = { confirm = a }, enabled = s.busy == null, modifier = Modifier.fillMaxWidth().testTag("pr.action.${a.wire}")) {
                                Text(a.label, color = if (a == PrAction.CLOSE) p.danger else p.accent, modifier = Modifier.weight(1f))
                            }
                        }
                    }
                    Text("Asks for your fingerprint or screen lock. GitHub’s own rules (reviews, required checks) still apply.",
                        style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
                }
            }
            val n = s.notice
            if (acted && n != null) item { Notice(n.text, if (n.ok) Tone.SUCCESS else Tone.DANGER, Modifier.testTag("pr.notice")) }
            if (s.busy != null) item { CircularProgressIndicator(color = p.accent) }
        }
    }
    confirm?.let { a ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("${a.label} #${current.number}?") },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch {
                        acted = true
                        git.prAction(current.url, a)?.pr?.let { current = it.copy(title = it.title.ifEmpty { current.title }) }
                    }
                }) { Text(a.label, color = if (a == PrAction.CLOSE) p.danger else p.accent) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun PrChecksPage(git: GitController, url: String, onBack: () -> Unit) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var list by remember { mutableStateOf<PrCheckList?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        try { list = git.checks(url); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
    }
    LaunchedEffect(url) { load() }
    Page(
        "Checks", onBack,
        actions = { IconButton(onClick = { scope.launch { load() } }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") } },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val l = list
            when {
                l != null -> {
                    if (l.items.isEmpty()) item { Text("No checks on this pull request.", color = p.inkSoft) }
                    itemsIndexed(l.items, key = { i, c -> "$i:${c.name}" }) { _, c ->
                        val (icon, tint) = when (c.state) {
                            PrCheck.State.PASS -> Icons.Filled.CheckCircle to p.success
                            PrCheck.State.FAIL -> Icons.Filled.Cancel to p.danger
                            PrCheck.State.PENDING -> Icons.Filled.Schedule to p.running
                            else -> Icons.Filled.RemoveCircleOutline to p.inkFaint
                        }
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(12.dp))
                                .then(if (c.link != null) Modifier.clickable { uri.openUri(c.link!!) } else Modifier).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                            Column(Modifier.weight(1f)) {
                                Text(c.name, style = MaterialTheme.typography.bodyMedium, color = p.ink)
                                Text(listOfNotNull(c.state.label, c.workflow, c.description).joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            if (c.link != null) Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = "Open ${c.name}", tint = p.inkFaint, modifier = Modifier.size(18.dp))
                        }
                    }
                    if (l.omitted > 0) item { Text("${l.omitted} more checks on GitHub.", style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
                }
                error != null -> item { Notice(error!!, Tone.DANGER) }
                else -> item { CircularProgressIndicator(color = p.accent) }
            }
        }
    }
}

@Composable
private fun PrFilesPage(git: GitController, url: String, onBack: () -> Unit, open: (GitPage) -> Unit) {
    val p = Nekko.palette
    var diff by remember { mutableStateOf<GitDiff?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(url) {
        try { diff = git.prDiff(url) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
    }
    Page("Files changed", onBack) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val d = diff
            when {
                d != null -> diffFiles(this, d, open, where = "GitHub")
                error != null -> item { Notice(error!!, Tone.DANGER) }
                else -> item { CircularProgressIndicator(color = p.accent) }
            }
        }
    }
}

// ---- small parts ----

@Composable
private fun Card(content: @Composable () -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(p.surface).border(1.dp, p.line, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
private fun Link(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onClick).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = p.accent)
        Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = p.inkFaint)
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = Nekko.palette.inkFaint, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 8.dp).semantics { heading() })
}

@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = modifier)
}

@Composable
private fun Empty(title: String, body: String, action: String? = null, onAction: () -> Unit = {}) {
    val p = Nekko.palette
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = p.ink)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.padding(top = 6.dp))
        if (action != null) TextButton(onClick = onAction, modifier = Modifier.padding(top = 8.dp)) { Text(action) }
    }
}

private fun relative(ms: Long): String {
    val now = System.currentTimeMillis()
    if (now - ms in 0 until DateUtils.MINUTE_IN_MILLIS) return "just now"
    return DateUtils.getRelativeTimeSpanString(ms, now, DateUtils.MINUTE_IN_MILLIS).toString()
}

private fun absolute(ms: Long): String =
    java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(ms))
