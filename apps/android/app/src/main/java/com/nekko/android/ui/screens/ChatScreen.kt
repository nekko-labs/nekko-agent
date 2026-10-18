package com.nekko.android.ui.screens

import com.nekko.android.voice.DictationController
import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.core.content.FileProvider
import com.nekko.android.chat.PhotoTray
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.chat.AttachUi
import java.io.File
import com.nekko.android.ui.chat.MicUi
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.DisposableEffect
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import android.content.pm.PackageManager
import android.Manifest
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Difference
import com.nekko.android.ui.chat.ChangesSheet
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.chat.ChatViewModel
import com.nekko.android.ui.chat.ApprovalCard
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.chat.QuestionCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Block
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel, initialDraft: String? = null, dictationOn: Boolean = false, onBack: () -> Unit) {
    val chat by vm.ui.collectAsStateWithLifecycle()
    val completedAt by vm.completedAt.collectAsStateWithLifecycle()
    val changesAllowed by vm.changesAllowed.collectAsStateWithLifecycle()
    val insert by vm.insert.collectAsStateWithLifecycle()
    var showChanges by remember { mutableStateOf(false) }
    var restoring by remember { mutableStateOf(false) }
    var restoreError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val p = Nekko.palette
    val mic = rememberMic(vm.dictation.takeIf { dictationOn })
    val attach = rememberAttach(vm)
    val list = rememberLazyListState()

    // Stable keys: a provider that reuses a call id across turns gets a suffix.
    val keyed = remember(chat.blocks) {
        val seen = HashMap<String, Int>()
        chat.blocks.map { b ->
            val kind = when (b) {
                is Block.User -> "user"
                is Block.Assistant -> "assistant"
                is Block.Tool -> "tool"
            }
            val base = "$kind:${b.id}"
            val n = seen.getOrDefault(base, 0)
            seen[base] = n + 1
            (if (n > 0) "$base#$n" else base) to b
        }
    }
    // A note above the messages when the computer sent only the newest ones.
    val headerCount = if (chat.omittedMessages > 0) 1 else 0
    val footerCount = 1
    val lastIndex = headerCount + keyed.size + footerCount - 1

    // Follow the reply while it streams, unless the user scrolled up to read.
    val streamTick = (chat.blocks.lastOrNull() as? Block.Assistant)?.let { it.text.length + (it.reasoning?.length ?: 0) } ?: 0
    LaunchedEffect(keyed.size, streamTick, chat.error) {
        if (keyed.isEmpty()) return@LaunchedEffect
        val info = list.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
        val nearBottom = lastVisible >= info.totalItemsCount - 3
        // totalItemsCount is 0 on the first frame: start at the bottom.
        if (nearBottom || info.totalItemsCount == 0) list.scrollToItem(lastIndex)
    }

    if (showChanges && changesAllowed) {
        val changes by vm.changes.collectAsStateWithLifecycle()
        ChangesSheet(
            changes.changes, changes.error, onRefresh = vm::loadChanges, onDismiss = { showChanges = false },
            onAsk = { quote -> vm.quote(quote); showChanges = false },
        )
    }

    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                actions = {
                    if (changesAllowed) {
                        IconButton(onClick = { vm.loadChanges(); showChanges = true }) {
                            Icon(Icons.Filled.Difference, contentDescription = "Changes")
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Icon(Icons.Filled.Computer, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(12.dp))
                            Text(
                                chat.subtitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = p.inkFaint,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()).imePadding()) {
            // Full width as well as the remaining height: without fillMaxWidth the box
            // wraps its content, so the loading spinner sat at the left edge.
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    !chat.ready -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.Center))
                    keyed.isEmpty() && chat.error == null -> Text(
                        "Ask your computer to do something. It can use its folders, tools and models.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = p.inkSoft,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(horizontal = 24.dp, vertical = 32.dp),
                    )
                    else -> LazyColumn(
                        state = list,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (chat.omittedMessages > 0) {
                            item(key = "omitted") {
                                Text(
                                    if (chat.omittedMessages == 1) "1 earlier message is on the computer."
                                    else "${chat.omittedMessages} earlier messages are on the computer.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = p.inkFaint,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                )
                            }
                        }
                        itemsIndexed(keyed, key = { _, (k, _) -> k }) { _, (_, block) -> BlockView(block) }
                        item(key = "footer") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                chat.error?.let { Notice(it, Tone.DANGER) }
                                val rate = chat.rate
                                if (!chat.running && rate != null) {
                                    Text(
                                        String.format(Locale.US, "%.1f tokens/s", rate),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = p.inkFaint,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            chat.approval?.let { ApprovalCard(it, onDecide = vm::approve) }
            chat.question?.let { QuestionCard(it, onAnswer = vm::answer) }
            // A completed chat reads like the desktop's: no message box until it is restored.
            if (completedAt != null && !chat.running) CompletedBar(
                restoring = restoring,
                error = restoreError,
                onRestore = {
                    restoring = true
                    restoreError = null
                    scope.launch {
                        try {
                            vm.restore()
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            restoreError = e.message?.takeIf { it.isNotBlank() } ?: "Couldn’t restore this chat."
                        } finally {
                            restoring = false
                        }
                    }
                },
                modifier = Modifier.navigationBarsPadding(),
            ) else Composer(
                initialText = initialDraft,
                running = chat.running,
                blocked = chat.blocked,
                queued = chat.queued,
                onSend = { text, skill, images -> vm.send(text, skill, images) },
                onStop = vm::stop,
                modifier = Modifier.navigationBarsPadding(),
                mic = mic,
                skills = chat.skills,
                insert = insert,
                onInserted = vm::inserted,
                attach = attach,
            )
        }
    }
}

/** In place of the message box for a completed chat: say so, and offer Restore. */
@Composable
private fun CompletedBar(restoring: Boolean, error: String?, onRestore: () -> Unit, modifier: Modifier = Modifier) {
    val p = Nekko.palette
    Column(
        modifier.fillMaxWidth().background(p.surface).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        error?.let { Notice(it, Tone.DANGER) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = p.success, modifier = Modifier.size(16.dp))
            Text(
                "This chat is completed. Restore it to keep going.",
                style = MaterialTheme.typography.bodyMedium,
                color = p.inkSoft,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = onRestore, enabled = !restoring) { Text(if (restoring) "Restoring…" else "Restore") }
        }
    }
}

/**
 * The composer's microphone: asks for RECORD_AUDIO the first time it is
 * tapped (Android shows its own prompt), then starts or stops dictation.
 */
@Composable
private fun rememberMic(d: DictationController?): MicUi? {
    if (d == null) return null
    val context = LocalContext.current
    val state by d.state.collectAsStateWithLifecycle()
    val error by d.error.collectAsStateWithLifecycle()
    var pending by remember { mutableStateOf<((String) -> Unit)?>(null) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val onText = pending
        pending = null
        if (granted && onText != null) d.toggle(onText)
        else if (!granted) d.denied()
    }
    // Leaving the chat drops a recording in progress; nothing is kept.
    DisposableEffect(d) { onDispose { d.cancel() } }
    return MicUi(state, error, d.computerName()) { onText ->
        val has = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (has) d.toggle(onText) else {
            pending = onText
            ask.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

/**
 * The **+** menu's photos: the system photo picker (no storage permission) and
 * the phone's camera app writing one shot into the cache through a
 * FileProvider (no CAMERA permission). The shot is deleted once it is read;
 * photos only ever live in memory. Both trips out of the app are announced to
 * the app lock, so coming back doesn't ask to unlock.
 */
@Composable
private fun rememberAttach(vm: ChatViewModel): AttachUi {
    val context = LocalContext.current
    val lock = LocalAppLock.current
    val state by vm.photos.state.collectAsStateWithLifecycle()
    // Where the camera app was asked to write; survives the activity being recreated meanwhile.
    var shot by rememberSaveable { mutableStateOf<String?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PhotoTray.MAX_PHOTOS)) { uris ->
        lock?.returned()
        vm.addPhotos(context.contentResolver, uris)
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        lock?.returned()
        val path = shot ?: return@rememberLauncherForActivityResult
        shot = null
        val file = File(path)
        if (ok && file.length() > 0) {
            vm.addPhotos(context.contentResolver, listOf(cameraUri(context, file))) { file.delete() }
        } else {
            file.delete()
        }
    }
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    return AttachUi(
        state = state,
        onPickFiles = {
            lock?.expectReturn()
            pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        },
        onTakePhoto = if (!hasCamera) null else {
            {
                val dir = File(context.cacheDir, "camera").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() } // a shot left by an interrupted trip
                val file = File(dir, "shot-${System.currentTimeMillis()}.jpg")
                shot = file.path
                lock?.expectReturn()
                try {
                    camera.launch(cameraUri(context, file))
                } catch (_: ActivityNotFoundException) {
                    lock?.returned()
                    shot = null
                    vm.photos.begin(1)
                    vm.photos.failed("No camera app on this phone.")
                }
            }
        },
        onRemove = vm.photos::remove,
        take = vm.photos::take,
        restore = vm.photos::restore,
        clearError = vm.photos::clearError,
    )
}

private fun cameraUri(context: Context, file: File): Uri =
    FileProvider.getUriForFile(context, "${context.packageName}.photos", file)
