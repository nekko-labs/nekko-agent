package com.nekko.android.ui.files

import android.content.Intent
import android.graphics.BitmapFactory
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.RemoveCircleOutline
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.data.ComputersRepository
import com.nekko.android.files.FileEditController
import com.nekko.android.files.FilesController
import com.nekko.android.files.LogsController
import com.nekko.android.files.LogsState
import com.nekko.android.ui.chat.MarkdownText
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.FileContent
import com.nekko.protocol.FileEntry
import com.nekko.protocol.FileListing
import com.nekko.protocol.FileRoot
import com.nekko.protocol.FileSearch
import com.nekko.protocol.LogInfo
import com.nekko.protocol.LogShare
import com.nekko.protocol.LogText
import com.nekko.protocol.RelayState
import com.nekko.protocol.WorkspaceFolder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One page of the files screens. */
sealed interface FilesPage {
    /** The computer's saved folders. */
    data object Folders : FilesPage
    data class Folder(val files: FilesController, val path: String, val title: String) : FilesPage
    data class File(val files: FilesController, val path: String) : FilesPage
    /** The editor keeps its draft here, so folding the phone keeps the edits. */
    data class Edit(val edit: FileEditController) : FilesPage
}

/**
 * The pages open over a chat or Settings. Kept in the repository (by chat id,
 * or [SETTINGS_KEY]) like Git and the Terminals, so folding or unfolding the
 * phone keeps the page and an unsaved draft.
 */
class FilesOverlay(start: FilesPage) {
    val stack = mutableStateListOf(start)

    companion object {
        const val SETTINGS_KEY = ":files"
    }
}

/** Files on the active computer: reads plain, saves signed with the phone's Change key. */
fun filesOn(repo: ComputersRepository, root: FileRoot) = FilesController(
    root,
    read = { r -> repo.caller.call(r.channel, *r.args.toTypedArray()) },
    change = { r -> repo.callChange(r.channel, r.args) },
)

/** A chat's files (AN-33, the iPhone's chat More → Files), full screen from the chat's ⋮ menu. */
@Composable
fun FilesDialog(files: FilesOverlay, repo: ComputersRepository, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
        FilesPages(files, repo, onDismiss)
    }
}

/** The computer's saved folders and their files (Settings → Files, the iPhone's computer menu → Files). */
@Composable
fun FilesScreen(repo: ComputersRepository, onBack: () -> Unit) {
    val files = remember {
        repo.overlays.value[FilesOverlay.SETTINGS_KEY] as? FilesOverlay
            ?: FilesOverlay(FilesPage.Folders).also { repo.setOverlay(FilesOverlay.SETTINGS_KEY, it) }
    }
    FilesPages(files, repo) { repo.setOverlay(FilesOverlay.SETTINGS_KEY, null); onBack() }
}

@Composable
private fun FilesPages(files: FilesOverlay, repo: ComputersRepository, onClose: () -> Unit) {
    val stack = files.stack
    val open: (FilesPage) -> Unit = { stack.add(it) }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else onClose() }
    BackHandler(onBack = back)
    // On an open folding phone the pages span both panes: keep them a readable width.
    Box(Modifier.fillMaxSize().background(Nekko.palette.paper), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
            val close = stack.size == 1
            val page = stack.last()
            // Each page keeps its own state: a subfolder must not reuse its parent's listing.
            key(stack.size, page) {
                when (page) {
                    FilesPage.Folders -> FoldersPage(repo, onClose, open)
                    is FilesPage.Folder -> FolderPage(page, back, close, open)
                    is FilesPage.File -> FilePage(page, back, open)
                    is FilesPage.Edit -> EditPage(page.edit, back)
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
                        if (close) Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.tools_close))
                        else Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.tools_back))
                    }
                },
                actions = { actions() },
            )
        },
        content = content,
    )
}

// ---- saved folders ----

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FoldersPage(repo: ComputersRepository, onClose: () -> Unit, open: (FilesPage) -> Unit) {
    val p = Nekko.palette
    val c by repo.state.collectAsStateWithLifecycle()
    val computer = c.active?.name ?: stringResource(R.string.tools_files_this_computer)
    val online = c.conn == RelayState.ONLINE
    val scope = rememberCoroutineScope()
    var adding by remember { mutableStateOf(false) }
    var folderPath by remember { mutableStateOf("") }
    var removing by remember { mutableStateOf<WorkspaceFolder?>(null) }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun act(work: suspend () -> Unit) {
        busy = true
        scope.launch {
            try {
                work()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = FilesController.message(e)
            } finally {
                busy = false
            }
        }
    }
    Page(stringResource(R.string.tools_files_title), onClose, close = true) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("files.folders"), contentPadding = PaddingValues(vertical = 8.dp)) {
            if (c.workspaces.isEmpty()) item { Note(stringResource(R.string.tools_files_no_folders, computer), Modifier.padding(16.dp)) }
            itemsIndexed(c.workspaces, key = { _, w -> w.id }) { _, w ->
                Box {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 56.dp)
                            .combinedClickable(
                                onClick = { open(FilesPage.Folder(filesOn(repo, FileRoot.Folder(w.id)), "", w.name)) },
                                onLongClick = { menuFor = w.id },
                            )
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .testTag("files.folder"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(Icons.Filled.Folder, contentDescription = null, tint = p.accent)
                        Column(Modifier.weight(1f)) {
                            Text(w.name, style = MaterialTheme.typography.bodyLarge, color = p.ink)
                            w.path?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.StartEllipsis) }
                        }
                    }
                    DropdownMenu(expanded = menuFor == w.id, onDismissRequest = { menuFor = null }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.tools_files_remove_saved), color = p.danger) },
                            leadingIcon = { Icon(Icons.Filled.RemoveCircleOutline, contentDescription = null, tint = p.danger) },
                            enabled = online && !busy,
                            onClick = { menuFor = null; removing = w },
                        )
                    }
                }
                HorizontalDivider(color = p.line, modifier = Modifier.padding(start = 52.dp))
            }
            item {
                TextButton(
                    onClick = { folderPath = ""; adding = true }, enabled = online && !busy,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp).testTag("files.addFolder"),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.tools_files_add_folder), modifier = Modifier.padding(start = 8.dp))
                }
                if (busy) CircularProgressIndicator(color = p.accent, modifier = Modifier.padding(horizontal = 16.dp).size(24.dp))
                Note(
                    stringResource(if (c.workspaces.isNotEmpty()) R.string.tools_files_path_note_hold else R.string.tools_files_path_note),
                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
    }
    if (adding) {
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text(stringResource(R.string.tools_files_add_folder)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.tools_files_enter_path, computer))
                    OutlinedTextField(
                        folderPath, { folderPath = it }, singleLine = true, placeholder = { Text("/Users/you/code/app") },
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().testTag("files.folderPath"),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = { adding = false; act { repo.addWorkspace(folderPath) } }, enabled = folderPath.isNotBlank()) { Text(stringResource(R.string.tools_files_add)) }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text(stringResource(R.string.tools_cancel)) } },
        )
    }
    removing?.let { w ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.tools_files_remove_title, w.name)) },
            text = { Text(stringResource(R.string.tools_files_remove_body)) },
            confirmButton = {
                TextButton(onClick = { removing = null; act { repo.removeWorkspace(w.id) } }) { Text(stringResource(R.string.tools_files_remove_saved), color = p.danger) }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.tools_cancel)) } },
        )
    }
    error?.let { e ->
        AlertDialog(
            onDismissRequest = { error = null },
            text = { Text(e) },
            confirmButton = { TextButton(onClick = { error = null }) { Text(stringResource(R.string.tools_ok)) } },
        )
    }
}

// ---- a folder ----

@Composable
private fun FolderPage(page: FilesPage.Folder, onBack: () -> Unit, close: Boolean, open: (FilesPage) -> Unit) {
    val files = page.files
    val scope = rememberCoroutineScope()
    var listing by remember { mutableStateOf<FileListing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<FileSearch?>(null) }
    var searching by remember { mutableStateOf(false) }
    suspend fun load() {
        error = null
        try {
            listing = files.list(page.path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = FilesController.message(e)
        }
    }
    LaunchedEffect(page) { if (listing == null) load() }
    LaunchedEffect(query) {
        val q = query.trim()
        if (q.isEmpty()) { hits = null; searching = false; return@LaunchedEffect }
        searching = true
        delay(300)
        try {
            hits = files.search(q)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = FilesController.message(e)
        } finally {
            searching = false
        }
    }
    val title = if (page.path.isEmpty()) page.title else page.path.substringAfterLast('/')
    Page(title, onBack, close, actions = {
        IconButton(onClick = { scope.launch { load() } }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.tools_refresh)) }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.tools_files_find)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("files.search"),
            )
            Box(Modifier.fillMaxSize()) {
                val h = hits
                val l = listing
                when {
                    query.isNotBlank() && h != null -> LazyColumn(Modifier.fillMaxSize().testTag("files.list")) {
                        if (h.hits.isEmpty() && !searching) item { Note(stringResource(R.string.tools_files_no_match), Modifier.padding(16.dp)) }
                        itemsIndexed(h.hits, key = { _, e -> e.path }) { _, e -> EntryRow(e, showPath = true) { open(FilesPage.File(files, e.path)) } }
                        if (h.truncated || !h.complete) item { Note(stringResource(R.string.tools_files_best_matches), Modifier.padding(16.dp)) }
                    }
                    query.isNotBlank() -> CircularProgressIndicator(color = Nekko.palette.accent, modifier = Modifier.align(Alignment.Center))
                    error != null && l == null -> Failure(error!!, files.readOff.collectAsStateWithLifecycle().value) { scope.launch { load() } }
                    l == null -> CircularProgressIndicator(color = Nekko.palette.accent, modifier = Modifier.align(Alignment.Center))
                    else -> LazyColumn(Modifier.fillMaxSize().testTag("files.list")) {
                        if (l.entries.isEmpty()) item { Note(stringResource(R.string.tools_files_empty_folder), Modifier.padding(16.dp)) }
                        itemsIndexed(l.entries, key = { _, e -> e.path }) { _, e ->
                            EntryRow(e) {
                                open(if (e.dir) FilesPage.Folder(files, e.path, page.title) else FilesPage.File(files, e.path))
                            }
                        }
                        item {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (l.truncated) Note(stringResource(R.string.tools_files_first_of, l.entries.size, l.total))
                                if (l.hiddenSecrets > 0) {
                                    Note(if (l.hiddenSecrets == 1) stringResource(R.string.tools_files_secrets_one)
                                    else stringResource(R.string.tools_files_secrets_other, l.hiddenSecrets))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EntryRow(e: FileEntry, showPath: Boolean = false, onClick: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag(if (e.dir) "files.folderRow" else "files.fileRow"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            when {
                e.dir -> Icons.Filled.Folder
                isImage(e.name) -> Icons.Filled.Image
                else -> Icons.AutoMirrored.Filled.InsertDriveFile
            },
            contentDescription = if (e.dir) stringResource(R.string.tools_files_folder) else null, tint = if (e.dir) p.accent else p.inkSoft, modifier = Modifier.size(22.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(e.name, style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (showPath && e.path != e.name) {
                Text(e.path, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.StartEllipsis)
            }
        }
        if (!e.dir) e.size?.let { Text(Formatter.formatShortFileSize(context, it), style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
    }
}

private fun isImage(name: String) = name.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico")

// ---- a file ----

private const val MAX_LINES = 5000

@Composable
private fun FilePage(page: FilesPage.File, onBack: () -> Unit, open: (FilesPage) -> Unit) {
    val p = Nekko.palette
    val files = page.files
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val changeOff by files.changeOff.collectAsStateWithLifecycle()
    val readOff by files.readOff.collectAsStateWithLifecycle()
    var file by remember { mutableStateOf<FileContent?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var rendered by remember { mutableStateOf(true) }
    suspend fun load() {
        error = null
        try {
            file = files.open(page.path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = FilesController.message(e)
        }
    }
    LaunchedEffect(page) { load() }
    val f = file
    Page(page.path.substringAfterLast('/'), onBack, actions = {
        if (f?.markdown == true) {
            IconToggleButton(checked = rendered, onCheckedChange = { rendered = it }) {
                Icon(Icons.Filled.TextFields, contentDescription = stringResource(R.string.tools_files_formatted), tint = if (rendered) p.accent else p.inkSoft)
            }
        }
        if (f != null && f.canEdit && !changeOff) {
            TextButton(onClick = { open(FilesPage.Edit(FileEditController(page.path, files, f))) }, modifier = Modifier.testTag("file.edit")) { Text(stringResource(R.string.tools_files_edit)) }
        }
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                f == null && error != null -> Failure(error!!, readOff) { scope.launch { load() } }
                f == null -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                f.kind == FileContent.Kind.IMAGE -> {
                    val bitmap = remember(f) { f.image?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }?.asImageBitmap() }
                    if (bitmap != null) {
                        // Scaled to fit the width (at most 600dp, as on the iPhone), however few pixels it has.
                        Image(
                            bitmap, contentDescription = f.name, contentScale = ContentScale.Fit,
                            modifier = Modifier.align(Alignment.TopCenter).padding(16.dp).widthIn(max = 600.dp).fillMaxWidth()
                                .aspectRatio(bitmap.width.toFloat() / bitmap.height.coerceAtLeast(1)),
                        )
                    } else {
                        Note(stringResource(R.string.tools_files_image_too_large, Formatter.formatShortFileSize(context, f.size)), Modifier.padding(16.dp))
                    }
                }
                f.kind == FileContent.Kind.BINARY ->
                    Note(stringResource(R.string.tools_files_binary, Formatter.formatShortFileSize(context, f.size)), Modifier.padding(16.dp))
                else -> {
                    val lines = remember(f) { f.lines }
                    LazyColumn(Modifier.fillMaxSize().testTag("file.view")) {
                        item {
                            when {
                                f.truncated -> Text(
                                    stringResource(
                                        R.string.tools_files_truncated,
                                        Formatter.formatShortFileSize(context, f.text.orEmpty().toByteArray().size.toLong()),
                                        Formatter.formatShortFileSize(context, f.size),
                                    ),
                                    style = MaterialTheme.typography.bodySmall, color = p.warning, modifier = Modifier.padding(12.dp).testTag("file.truncated"),
                                )
                                !f.editable -> Note(stringResource(R.string.tools_files_read_only), Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                                changeOff -> Note(stringResource(R.string.tools_files_change_off), Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                            }
                        }
                        if (rendered && f.markdown && f.text != null) {
                            item { MarkdownText(f.text!!, p.ink, Modifier.padding(12.dp)) }
                        } else {
                            itemsIndexed(lines.take(MAX_LINES)) { i, line -> CodeLine(i + 1, line) }
                            if (lines.size > MAX_LINES) item { Note(stringResource(R.string.tools_files_first_lines, MAX_LINES), Modifier.padding(16.dp)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CodeLine(n: Int, line: String) {
    val p = Nekko.palette
    Row(Modifier.fillMaxWidth().background(p.code).padding(horizontal = 8.dp)) {
        Text(
            "$n", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = p.inkFaint,
            modifier = Modifier.widthIn(min = 36.dp).padding(end = 8.dp, top = 2.dp),
        )
        Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = p.ink, modifier = Modifier.weight(1f))
    }
}

// ---- editing ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditPage(edit: FileEditController, onBack: () -> Unit) {
    val p = Nekko.palette
    val s by edit.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var confirmDiscard by remember { mutableStateOf(false) }
    val cancel = { if (s.dirty) confirmDiscard = true else onBack() }
    BackHandler(onBack = cancel)
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                title = { Text(edit.path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() }) },
                navigationIcon = { IconButton(onClick = cancel) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.tools_cancel)) } },
                actions = {
                    if (s.saving) {
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.padding(horizontal = 16.dp).size(24.dp))
                    } else {
                        TextButton(
                            onClick = { scope.launch { if (edit.save()) onBack() } },
                            enabled = edit.canSave(s), modifier = Modifier.testTag("file.save"),
                        ) { Text(stringResource(R.string.tools_files_save)) }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            s.error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = p.danger, modifier = Modifier.fillMaxWidth().padding(12.dp).testTag("file.saveError"))
            }
            BasicTextField(
                s.draft, edit::edit,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, color = p.ink),
                cursorBrush = SolidColor(p.accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.weight(1f).fillMaxWidth().background(p.code).padding(12.dp).testTag("file.editor"),
            )
            Note(stringResource(R.string.tools_files_save_note), Modifier.padding(10.dp))
        }
    }
    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(stringResource(R.string.tools_files_discard_title)) },
            confirmButton = { TextButton(onClick = { confirmDiscard = false; onBack() }) { Text(stringResource(R.string.tools_files_discard), color = p.danger) } },
            dismissButton = { TextButton(onClick = { confirmDiscard = false }) { Text(stringResource(R.string.tools_files_keep_editing)) } },
        )
    }
    if (s.conflict) {
        AlertDialog(
            onDismissRequest = edit::dismissConflict,
            title = { Text(stringResource(R.string.tools_files_changed_title)) },
            text = {
                Text(
                    stringResource(if (s.canOverwrite) R.string.tools_files_changed_body else R.string.tools_files_removed_body),
                )
            },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = { scope.launch { edit.reload() } }) { Text(stringResource(R.string.tools_files_reload_losing), color = p.danger) }
                    if (s.canOverwrite) TextButton(onClick = { scope.launch { if (edit.overwrite()) onBack() } }) { Text(stringResource(R.string.tools_files_save_over)) }
                    TextButton(onClick = edit::dismissConflict) { Text(stringResource(R.string.tools_files_keep_editing)) }
                }
            },
        )
    }
}

// ---- logs (AN-34) ----

/** The computer's logs, read only (Settings → Logs, the iPhone's computer menu → Logs). */
@Composable
fun LogsScreen(repo: ComputersRepository, onBack: () -> Unit) {
    val logs = remember { LogsController { r -> repo.caller.call(r.channel, *r.args.toTypedArray()) } }
    // The open log survives folding the phone (a new activity); its lines are read again.
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    val s by logs.state.collectAsStateWithLifecycle()
    LaunchedEffect(logs) { logs.load() }
    val open = openId?.let { id -> s.logs.firstOrNull { it.id == id } }
    BackHandler { if (openId != null) openId = null else onBack() }
    Box(Modifier.fillMaxSize().background(Nekko.palette.paper), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
            if (open != null) key(open.id) { LogPage(logs, open) { openId = null } }
            else LogsList(logs, s, onBack) { openId = it.id }
        }
    }
}

@Composable
private fun LogsList(logs: LogsController, s: LogsState, onBack: () -> Unit, open: (LogInfo) -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Page(stringResource(R.string.tools_logs_title), onBack, actions = {
        IconButton(onClick = { scope.launch { logs.load() } }) { Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.tools_refresh)) }
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                !s.loaded -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                s.error != null && s.logs.isEmpty() -> Failure(s.error, readOff = false) { scope.launch { logs.load() } }
                else -> LazyColumn(Modifier.fillMaxSize().testTag("logs.list")) {
                    if (s.logs.isEmpty()) item { Note(stringResource(R.string.tools_logs_none), Modifier.padding(16.dp)) }
                    itemsIndexed(s.logs, key = { _, l -> l.id }) { _, l ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable { open(l) }.padding(horizontal = 16.dp, vertical = 8.dp).testTag("logs.row"),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(
                                when (l.kind) {
                                    LogInfo.Kind.APP -> Icons.Filled.DesktopWindows
                                    LogInfo.Kind.DAEMON -> Icons.Filled.Settings
                                    LogInfo.Kind.AGENT -> Icons.AutoMirrored.Filled.Chat
                                },
                                contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(22.dp),
                            )
                            Column(Modifier.weight(1f)) {
                                Text(l.title, style = MaterialTheme.typography.bodyLarge, color = p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                val at = l.updatedAt
                                Text(
                                    if (at == null) stringResource(R.string.tools_logs_empty)
                                    else "${Formatter.formatShortFileSize(context, l.size)} · ${DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)}",
                                    style = MaterialTheme.typography.bodySmall, color = p.inkSoft,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A log's tail, newest at the bottom, or its lines matching a search; Share sends what is shown, redacted again. */
@Composable
private fun LogPage(logs: LogsController, log: LogInfo, onBack: () -> Unit) {
    val p = Nekko.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tail by remember { mutableStateOf<LogText?>(null) }
    var found by remember { mutableStateOf<LogText?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    suspend fun load() {
        loading = true
        try {
            tail = logs.tail(log.id)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = FilesController.message(e)
        } finally {
            loading = false
        }
    }
    LaunchedEffect(log.id) { load() }
    LaunchedEffect(query) {
        val q = query.trim()
        if (q.isEmpty()) { found = null; return@LaunchedEffect }
        delay(300)
        loading = true
        try {
            found = logs.search(log.id, q)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            found = null
            error = FilesController.message(e)
        } finally {
            loading = false
        }
    }
    val searching = query.isNotBlank()
    val shown = if (searching) found else tail
    val shareSubject = stringResource(R.string.tools_logs_share_subject, log.title)
    // Newest at the bottom: open there, and again after Refresh.
    LaunchedEffect(tail) { tail?.let { if (it.lines.isNotEmpty()) list.scrollToItem(it.lines.size) } }
    Page(log.title, onBack, actions = {
        IconButton(onClick = { scope.launch { load() } }, enabled = !loading, modifier = Modifier.testTag("log.refresh")) {
            Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.tools_refresh))
        }
        if (shown != null) {
            IconButton(
                onClick = {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, shareSubject)
                        .putExtra(Intent.EXTRA_TEXT, LogShare.text(log.title, shown))
                    context.startActivity(Intent.createChooser(send, null))
                },
                modifier = Modifier.testTag("log.share"),
            ) { Icon(Icons.Filled.Share, contentDescription = stringResource(R.string.tools_logs_share)) }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            OutlinedTextField(
                query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.tools_logs_find)) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("log.search"),
            )
            Box(Modifier.fillMaxSize()) {
                val t = tail
                val f = found
                when {
                    searching && f != null -> LazyColumn(Modifier.fillMaxSize()) {
                        if (f.matches.isEmpty() && !loading) item { Note(stringResource(R.string.tools_logs_no_match), Modifier.padding(16.dp)) }
                        itemsIndexed(f.matches, key = { _, m -> m.line }) { _, m -> CodeLine(m.line, m.text) }
                        if (f.moreMatches) item { Note(stringResource(R.string.tools_logs_more_match), Modifier.padding(16.dp)) }
                    }
                    searching && error != null -> Failure(error!!, readOff = false) { query = query.trim() }
                    searching -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                    t != null -> LazyColumn(Modifier.fillMaxSize().background(p.code).testTag("log.view"), state = list) {
                        item {
                            if (t.truncated) Note(stringResource(R.string.tools_logs_older), Modifier.padding(12.dp))
                        }
                        itemsIndexed(t.lines) { _, line ->
                            Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = p.ink,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp))
                        }
                    }
                    error != null -> Failure(error!!, readOff = false) { scope.launch { load() } }
                    else -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                }
            }
        }
    }
}

// ---- shared ----

@Composable
private fun Failure(message: String, readOff: Boolean, retry: () -> Unit) {
    val p = Nekko.palette
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(if (readOff) R.string.tools_files_reading_off else R.string.tools_cant_open), style = MaterialTheme.typography.titleMedium, color = p.ink)
        Text(message, style = MaterialTheme.typography.bodyMedium, color = p.inkSoft, modifier = Modifier.padding(top = 6.dp))
        TextButton(onClick = retry, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.tools_try_again)) }
    }
}

@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = modifier)
}
