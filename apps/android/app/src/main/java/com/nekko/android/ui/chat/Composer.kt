package com.nekko.android.ui.chat

import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import com.nekko.protocol.Draft

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.semantics.selected
import androidx.compose.material.icons.filled.TextFormat
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.Engine
import com.nekko.android.voice.MicState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material3.IconButton
import androidx.compose.ui.text.font.FontWeight
import com.nekko.android.chat.SkillMenu
import com.nekko.protocol.SkillSummary
import androidx.compose.ui.platform.testTag
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material.icons.filled.Bookmark
import com.nekko.protocol.QueuedPrompt
import com.nekko.protocol.SavedPrompt
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import com.nekko.android.chat.PhotoTray
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Prompt box: the text across the full width, and inside the box below it **+**
 * on the left (a new agent, a terminal, dictation, an image from files, a photo
 * from the camera) and Send on the right. While a run is going, sending
 * queues the prompt on the computer and an empty box turns Send into Stop.
 * Typing `/` offers the computer's skills; a picked skill shows as a chip and
 * the box becomes its input. Photos show as thumbnails above the box.
 */
@Composable
fun Composer(
    running: Boolean,
    blocked: String?,
    queued: List<String>,
    onSend: suspend (String, SkillSummary?, List<String>) -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    /** Pre-filled once (text shared from another app); the user still presses Send. */
    initialText: String? = null,
    /** The microphone, when dictation is on (Settings → Dictation); null hides it. */
    mic: MicUi? = null,
    /** The computer's runnable skills for the `/` menu; empty hides it. */
    skills: List<SkillSummary> = emptyList(),
    /** Text to add after what's typed ("Ask about this" in Changes); [onInserted] once it's in. */
    insert: String? = null,
    onInserted: () -> Unit = {},
    /** Photos from files or the camera (the **+** menu); null leaves them out. */
    attach: AttachUi? = null,
    /** The computer's saved prompts, offered by `/` beside its skills (AN-29). */
    prompts: List<SavedPrompt> = emptyList(),
    /** The queue as the computer holds it, for Edit and Remove; same order as [queued]. */
    queuedPrompts: List<QueuedPrompt> = emptyList(),
    /** Change ([text]) or remove (null) the queued prompt at an index, checked against what was shown. */
    onEditQueued: (suspend (index: Int, expect: String, text: String?) -> Unit)? = null,
    /** Give the running agent a queued prompt at its next step. */
    onNextStep: (suspend (index: Int, expect: String) -> Unit)? = null,
    /** Stop the reply and start a queued prompt. */
    onInterrupt: (suspend (index: Int) -> Unit)? = null,
    /** **+** → New agent, as on the desktop; null leaves it out. */
    onNewAgent: (() -> Unit)? = null,
    /** **+** → Terminal: the chat's terminals; null leaves it out. */
    onTerminal: (() -> Unit)? = null,
    /** The skill armed in the saved draft, by name. */
    initialSkillName: String? = null,
    /** What the box holds changed (text, armed skill's name): the chat keeps it as its draft. */
    onDraftChange: ((text: String, skillName: String?) -> Unit)? = null,
    /** A prompt back from the outbox (Edit or refused), already merged with what was typed: replaces the box once. */
    restore: Draft? = null,
    onRestored: () -> Unit = {},
    /** The computer is out of reach: what is sent waits on the phone (offline mode); said under the box. */
    sendsLater: String? = null,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf(initialText.orEmpty()) }
    var sending by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    // The armed skill, by name: it survives rotation and is dropped if the computer no longer has it.
    var skillName by rememberSaveable { mutableStateOf(initialSkillName) }
    val skill = skillName?.let { n -> skills.firstOrNull { it.name == n } }
    // The armed saved prompt, by id: it sends its text, then what was typed.
    var promptId by rememberSaveable { mutableStateOf<String?>(null) }
    val prompt = promptId?.let { id -> prompts.firstOrNull { it.id == id } }
    val armedNone = skill == null && prompt == null
    val menu = if (armedNone) SkillMenu.query(text)?.let { SkillMenu.match(skills, it) }.orEmpty() else emptyList()
    val promptMenu = if (armedNone) SkillMenu.query(text)?.let { SkillMenu.matchPrompts(prompts, it) }.orEmpty() else emptyList()
    val photos = attach?.state?.photos.orEmpty()
    val addingPhotos = attach?.state?.busy == true
    val hasContent = text.isNotBlank() || skill != null || prompt != null || photos.isNotEmpty()
    // Send waits for photos still being read, so none are left behind.
    val canSend = hasContent && blocked == null && !sending && !addingPhotos
    val showStop = running && !hasContent && !addingPhotos
    var plusOpen by remember { mutableStateOf(false) }
    // The Markdown editing (MD-6): the selection the toolbar acts on, and the formatting toolbar's switch (*Aa*).
    val context = LocalContext.current
    val resources = LocalResources.current
    val draft = remember { MarkdownDraft() }
    val setText: (String) -> Unit = {
        text = it
        error = null
    }
    var focused by remember { mutableStateOf(false) }
    var toolbarOn by remember { mutableStateOf(ToolbarPref.get(context)) }
    LaunchedEffect(restore) {
        if (restore != null) {
            text = restore.text
            skillName = restore.skill?.name
            error = null
            onRestored()
        }
    }
    LaunchedEffect(text, skillName) { onDraftChange?.invoke(text, skillName) }
    LaunchedEffect(insert) {
        if (insert != null) {
            text += (if (text.isEmpty() || text.endsWith("\n")) "" else "\n\n") + insert
            onInserted()
        }
    }
    // Dictated text goes after what is typed, never replacing it, and is never sent by itself.
    val dictated: (String) -> Unit = { spoken ->
        text = Dictation.insert(text, text.length, spoken).first
        error = null
    }

    val send = {
        if (canSend) {
            // `/name rest` typed out in full runs that skill too, as on the desktop.
            val typedText = text
            val armedPrompt = prompt
            var (armed, value) = skill?.let { it to text.trim() } ?: SkillMenu.typed(text, skills) ?: (null to text.trim())
            // A saved prompt sends its text, then what was typed: an ordinary prompt the computer runs.
            if (armed == null) value = armedPrompt?.text(text) ?: SkillMenu.typedPrompt(text, prompts) ?: value
            val sentPhotos = attach?.take?.invoke().orEmpty()
            sending = true
            text = ""
            skillName = null
            promptId = null
            error = null
            scope.launch {
                try {
                    onSend(value, armed, sentPhotos.map { it.dataUrl })
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    text = if (armed == null) typedText.trim() else value // keep what they typed if it didn't go
                    skillName = armed?.name
                    promptId = armedPrompt?.id
                    attach?.restore?.invoke(sentPhotos)
                    error = e.message ?: resources.getString(R.string.chat_send_failed)
                } finally {
                    sending = false
                }
            }
        }
    }

    Column(modifier.fillMaxWidth().background(p.paper)) {
        HorizontalDivider(color = p.line)
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (queued.isNotEmpty()) {
                QueueList(queued, queuedPrompts, onEditQueued, if (running) onNextStep else null, if (running) onInterrupt else null) { error = it }
            }
            mic?.let { m ->
                when (val st = m.state) {
                    is MicState.Recording -> RecordingBar(st)
                    is MicState.Transcribing -> Text(
                        if (st.engine == Engine.COMPUTER) stringResource(R.string.chat_transcribing_on, m.computerName) else stringResource(R.string.chat_transcribing),
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkSoft,
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )
                    MicState.Idle -> Unit
                }
            }
            if (menu.isNotEmpty() || promptMenu.isNotEmpty()) SkillList(menu, promptMenu, onPickPrompt = { picked ->
                // After existing text the prompt's text replaces the `/query`; alone it becomes the chip.
                if (SkillMenu.trigger(text)?.start == 0) {
                    promptId = picked.id
                    text = ""
                } else {
                    text = SkillMenu.textAfterPrompt(text, picked.text(""))
                }
                error = null
            }) { picked ->
                skillName = picked.name
                text = SkillMenu.afterPick(text)
                error = null
            }
            skill?.let { SkillChip("/${it.name}", Icons.Filled.Extension, stringResource(R.string.chat_remove_skill, it.name)) { skillName = null } }
            prompt?.let { SkillChip("/${it.name}", Icons.Filled.Bookmark, stringResource(R.string.chat_remove_saved_prompt, it.name)) { promptId = null } }
            if (attach != null && (photos.isNotEmpty() || addingPhotos)) PhotoStrip(photos, attach.state.adding, attach.onRemove)
            val note = blocked ?: error ?: mic?.error ?: attach?.state?.error
            if (note != null) {
                Text(
                    note,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (blocked != null) p.warning else p.danger,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            } else if (sendsLater != null) {
                Text(sendsLater, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(horizontal = 4.dp).testTag("composer.sendsLater"))
            }
            // One box the width of the screen: the message on top, + and Send inside it below.
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(p.surface)
                    .border(1.dp, p.line, RoundedCornerShape(16.dp))
                    .padding(6.dp),
            ) {
                // The toolbar sits inside the card, above the text, while the box is in use.
                if (focused && toolbarOn) MarkdownToolbar(draft, text, setText)
                PastedChip(draft, text, setText)
                val fieldValue = draft.valueFor(text)
                val messageLabel = stringResource(R.string.chat_message)
                BasicTextField(
                    value = fieldValue,
                    // Against the current value, not this composition's: a paste or a toolbar edit may have just replaced it.
                    onValueChange = { draft.changed(draft.valueFor(text), it, setText) },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = p.ink),
                    cursorBrush = SolidColor(p.accent),
                    maxLines = 6,
                    // The source with light styling; what is sent is exactly what was typed.
                    visualTransformation = remember(p) { MarkdownStyling(p.inkFaint, p.accent, p.code) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .padding(horizontal = 8.dp, vertical = 12.dp)
                        .onFocusChanged { focused = it.hasFocus }
                        .markdownKeys(draft, { text }, setText)
                        .markdownPaste(context, draft, { text }, setText)
                        .semantics { contentDescription = messageLabel },
                    decorationBox = { inner ->
                        if (text.isEmpty()) {
                            Text(
                                when {
                                    skill != null -> stringResource(R.string.chat_add_details_for, skill.name)
                                    running -> stringResource(R.string.chat_queue_follow_up)
                                    skills.isNotEmpty() -> stringResource(R.string.chat_message_slash_skills)
                                    else -> stringResource(R.string.chat_message_your_computer)
                                },
                                style = MaterialTheme.typography.bodyLarge,
                                color = p.inkFaint,
                                // One line, so the empty box is as tall as one with a line typed.
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        inner()
                    },
                )
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    val recording = mic?.state is MicState.Recording
                    val transcribing = mic?.state is MicState.Transcribing
                    if (mic != null && (recording || transcribing)) {
                        // Dictating: + becomes the way to finish (■), as the mic button was.
                        MicButton(mic, onText = dictated)
                    } else {
                        Box {
                            PlusButton(open = plusOpen) { plusOpen = true }
                            PlusMenu(
                                open = plusOpen,
                                onDismiss = { plusOpen = false },
                                onNewAgent = onNewAgent?.let { go -> { plusOpen = false; go() } },
                                onTerminal = onTerminal?.let { go -> { plusOpen = false; go() } },
                                onDictate = mic?.let { m -> { plusOpen = false; m.onTap(dictated) } },
                                attach = attach,
                                onPicked = { plusOpen = false; attach?.clearError?.invoke() },
                                prompts = prompts,
                                onPrompt = { picked ->
                                    plusOpen = false
                                    // Armed like a skill: it sends its text, then what is typed.
                                    promptId = picked.id
                                    skillName = null
                                    error = null
                                },
                            )
                        }
                    }
                    // *Aa*: show or hide the formatting toolbar, remembered.
                    IconButton(
                        onClick = {
                            toolbarOn = !toolbarOn
                            ToolbarPref.set(context, toolbarOn)
                        },
                        modifier = Modifier.semantics { selected = toolbarOn }.testTag("composer.formatting"),
                    ) {
                        Icon(
                            Icons.Filled.TextFormat,
                            contentDescription = if (toolbarOn) stringResource(R.string.chat_hide_formatting) else stringResource(R.string.chat_show_formatting),
                            tint = if (toolbarOn) p.accent else p.inkSoft,
                        )
                    }
                    Spacer(Modifier.weight(1f))
                    FilledIconButton(
                        onClick = { if (showStop) onStop() else send() },
                        enabled = showStop || canSend,
                        shape = CircleShape,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = if (showStop) p.danger else p.accent,
                            contentColor = p.accentInk,
                            disabledContainerColor = p.surface2,
                            disabledContentColor = p.inkFaint,
                        ),
                        modifier = Modifier.size(48.dp),
                    ) {
                        if (showStop) {
                            Icon(Icons.Filled.Stop, contentDescription = stringResource(R.string.chat_stop))
                        } else {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = when {
                                sendsLater != null -> stringResource(R.string.chat_send_when_online)
                                running -> stringResource(R.string.chat_queue)
                                else -> stringResource(R.string.chat_send)
                            })
                        }
                    }
                }
            }
        }
    }
}

/** The `/` menu: the computer's skills matching what's typed after the slash. */
@Composable
private fun SkillList(skills: List<SkillSummary>, prompts: List<SavedPrompt>, onPickPrompt: (SavedPrompt) -> Unit, onPick: (SkillSummary) -> Unit) {
    val p = Nekko.palette
    val menuLabel = stringResource(R.string.chat_saved_prompts_and_skills)
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 260.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(p.surface)
            .border(1.dp, p.line, RoundedCornerShape(12.dp))
            .verticalScroll(rememberScrollState())
            .semantics { contentDescription = menuLabel },
    ) {
        prompts.forEach { pr ->
            Column(Modifier.fillMaxWidth().clickable { onPickPrompt(pr) }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("/${pr.name}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
                    Text(stringResource(R.string.chat_saved_prompt), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
                }
                if (pr.body.isNotBlank()) {
                    Text(pr.body, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        skills.forEach { s ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable { onPick(s) }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("/${s.name}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
                    Text(SkillMenu.sourceLabel(s.source), style = MaterialTheme.typography.labelSmall, color = p.inkFaint)
                }
                if (s.description.isNotBlank()) {
                    Text(s.description, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** The armed skill, above the message box; ✕ disarms it. */
@Composable
private fun SkillChip(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, clearLabel: String, onClear: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(p.accentSoft)
            .padding(start = 10.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = null, tint = p.accent, modifier = Modifier.size(16.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
        IconButton(onClick = onClear, modifier = Modifier.size(36.dp)) {
            Icon(Icons.Filled.Close, contentDescription = clearLabel, tint = p.inkSoft, modifier = Modifier.size(16.dp))
        }
    }
}

/**
 * The prompts waiting for this run, oldest first (AN-29, the iPhone's
 * IO-22): **Edit** changes one before it runs (not a skill's, whose text is
 * its instructions), ✕ removes it. The computer refuses an edit once that
 * prompt started or the queue moved, and the queue is read again.
 */
@Composable
private fun QueueList(
    queued: List<String>,
    prompts: List<QueuedPrompt>,
    onEdit: (suspend (Int, String, String?) -> Unit)?,
    onNextStep: (suspend (Int, String) -> Unit)?,
    onInterrupt: (suspend (Int) -> Unit)?,
    onError: (String?) -> Unit,
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val resources = LocalResources.current
    var editing by remember { mutableStateOf<Int?>(null) }
    var draft by remember { mutableStateOf("") }
    fun run(work: suspend () -> Unit) {
        scope.launch {
            try {
                work()
                onError(null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onError(e.message ?: resources.getString(R.string.chat_queue_change_failed))
            }
        }
    }
    fun act(index: Int, text: String?) {
        val q = prompts.getOrNull(index) ?: return
        val edit = onEdit ?: return
        run { edit(index, q.text, text) }
    }
    Text(
        if (queued.size == 1) stringResource(R.string.chat_queued_one) else stringResource(R.string.chat_queued_other, queued.size),
        style = MaterialTheme.typography.bodySmall,
        color = p.inkFaint,
    )
    queued.forEachIndexed { i, q ->
        val editable = prompts.getOrNull(i)?.editable == true && onEdit != null
        Row(Modifier.testTag("queue.row.$i"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
            Text(q, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (editable) {
                TextButton(onClick = { draft = prompts[i].text; editing = i }, modifier = Modifier.heightIn(min = 36.dp)) { Text(stringResource(R.string.chat_edit)) }
            }
            if (onEdit != null && prompts.getOrNull(i) != null) {
                IconButton(onClick = { act(i, null) }, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chat_remove_queued), tint = p.inkSoft, modifier = Modifier.size(16.dp))
                }
            }
        }
        val prompt = prompts.getOrNull(i)
        if (prompt != null && (onNextStep != null || onInterrupt != null)) {
            Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (onNextStep != null && prompt.canTakeAtNextStep) {
                    TextButton(onClick = { run { onNextStep(i, prompt.text) } }, modifier = Modifier.heightIn(min = 36.dp).testTag("queue.nextStep.$i")) { Text("Next step") }
                }
                if (onInterrupt != null) {
                    TextButton(onClick = { run { onInterrupt(i) } }, modifier = Modifier.heightIn(min = 36.dp).testTag("queue.interrupt.$i")) { Text("Interrupt") }
                }
            }
        }
    }
    editing?.let { i ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(stringResource(R.string.chat_edit_queued)) },
            text = { OutlinedTextField(draft, { draft = it }, minLines = 2, maxLines = 8, modifier = Modifier.fillMaxWidth().testTag("queue.edit")) },
            confirmButton = {
                TextButton(onClick = { editing = null; act(i, draft) }, enabled = draft.isNotBlank()) { Text(stringResource(R.string.chat_save)) }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text(stringResource(R.string.chat_cancel)) } },
        )
    }
}

/** Photos from the phone as the composer sees them; the chat screen builds it from the chat's [PhotoTray]. */
class AttachUi(
    val state: PhotoTray.State<ImageBitmap>,
    /** Opens the system photo picker (files and gallery; no storage permission). */
    val onPickFiles: () -> Unit,
    /** Opens the camera app for one shot; null when the phone has no camera app. */
    val onTakePhoto: (() -> Unit)?,
    val onRemove: (Long) -> Unit,
    val take: () -> List<PhotoTray.Photo<ImageBitmap>>,
    val restore: (List<PhotoTray.Photo<ImageBitmap>>) -> Unit,
    val clearError: () -> Unit,
)

@Composable
private fun PlusButton(open: Boolean, onClick: () -> Unit) {
    val p = Nekko.palette
    FilledIconButton(
        onClick = onClick,
        shape = CircleShape,
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = if (open) p.accentSoft else p.surface2,
            contentColor = if (open) p.accent else p.inkSoft,
        ),
        modifier = Modifier.size(48.dp),
    ) {
        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.chat_add))
    }
}

/** The **+** menu: a new agent or a terminal (as on the desktop), dictation, an image from the phone's files, a photo from the camera, the saved prompts. */
@Composable
private fun PlusMenu(
    open: Boolean,
    onDismiss: () -> Unit,
    onNewAgent: (() -> Unit)?,
    onTerminal: (() -> Unit)?,
    onDictate: (() -> Unit)?,
    attach: AttachUi?,
    onPicked: () -> Unit,
    prompts: List<SavedPrompt> = emptyList(),
    onPrompt: (SavedPrompt) -> Unit = {},
) {
    val p = Nekko.palette
    val full = attach != null && attach.state.room == 0
    DropdownMenu(
        expanded = open,
        onDismissRequest = onDismiss,
        containerColor = p.surface,
        shape = RoundedCornerShape(14.dp),
    ) {
        if (onNewAgent != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_new_agent), color = p.ink) },
                leadingIcon = { Icon(Icons.Filled.AddComment, contentDescription = null, tint = p.inkSoft) },
                onClick = onNewAgent,
                modifier = Modifier.testTag("composer.newAgent"),
            )
        }
        if (onTerminal != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_terminal), color = p.ink) },
                leadingIcon = { Icon(Icons.Filled.Terminal, contentDescription = null, tint = p.inkSoft) },
                onClick = onTerminal,
                modifier = Modifier.testTag("composer.terminal"),
            )
        }
        if ((onNewAgent != null || onTerminal != null) && (onDictate != null || attach != null)) HorizontalDivider(color = p.line)
        if (onDictate != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_dictate), color = p.ink) },
                leadingIcon = { Icon(Icons.Filled.Mic, contentDescription = null, tint = p.inkSoft) },
                onClick = onDictate,
            )
        }
        if (attach != null) {
            val hint: @Composable (() -> Unit)? = if (full) {
                { Text(stringResource(R.string.chat_photos_max, PhotoTray.MAX_PHOTOS), style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
            } else null
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_image_from_files), color = if (full) p.inkFaint else p.ink) },
                leadingIcon = { Icon(Icons.Filled.AttachFile, contentDescription = null, tint = if (full) p.inkFaint else p.inkSoft) },
                trailingIcon = hint,
                enabled = !full,
                onClick = { onPicked(); attach.onPickFiles() },
            )
            attach.onTakePhoto?.let { take ->
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_take_photo), color = if (full) p.inkFaint else p.ink) },
                    leadingIcon = { Icon(Icons.Filled.PhotoCamera, contentDescription = null, tint = if (full) p.inkFaint else p.inkSoft) },
                    enabled = !full,
                    onClick = { onPicked(); take() },
                )
            }
        }
        if (prompts.isNotEmpty()) {
            if (onNewAgent != null || onTerminal != null || onDictate != null || attach != null) HorizontalDivider(color = p.line)
            prompts.forEach { pr ->
                DropdownMenuItem(
                    text = { Text("/${pr.name}", color = p.ink) },
                    leadingIcon = { Icon(Icons.Filled.Bookmark, contentDescription = null, tint = p.inkSoft) },
                    onClick = { onPrompt(pr) },
                )
            }
        }
    }
}

/** Thumbnails of the photos going with the next message; ✕ takes one out. */
@Composable
private fun PhotoStrip(photos: List<PhotoTray.Photo<ImageBitmap>>, adding: Int, onRemove: (Long) -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        photos.forEachIndexed { i, photo ->
            val removeLabel = stringResource(R.string.chat_remove_photo, i + 1)
            Box(Modifier.size(64.dp)) {
                Image(
                    photo.preview,
                    contentDescription = stringResource(R.string.chat_photo_n, i + 1),
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).border(1.dp, p.line, RoundedCornerShape(10.dp)),
                )
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .size(40.dp)
                        .clip(CircleShape)
                        .clickable { onRemove(photo.id) }
                        .semantics { contentDescription = removeLabel },
                    contentAlignment = Alignment.TopEnd,
                ) {
                    Box(Modifier.padding(3.dp).size(20.dp).clip(CircleShape).background(p.ink.copy(alpha = 0.72f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, contentDescription = null, tint = p.paper, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
        val addingLabel = stringResource(R.string.chat_adding_photo)
        repeat(adding) {
            Box(
                Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).background(p.surface2).semantics { contentDescription = addingLabel },
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(strokeWidth = 2.dp, color = p.accent, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** The microphone as the composer sees it; the chat screen builds it from [DictationController]. */
class MicUi(
    val state: MicState,
    val error: String?,
    val computerName: String,
    /** Tap: start, or stop and transcribe. The screen asks for the microphone permission first. */
    val onTap: (onText: (String) -> Unit) -> Unit,
)

@Composable
private fun MicButton(mic: MicUi, onText: (String) -> Unit) {
    val p = Nekko.palette
    val recording = mic.state is MicState.Recording
    val busy = mic.state is MicState.Transcribing
    FilledIconButton(
        onClick = { mic.onTap(onText) },
        enabled = !busy,
        shape = CircleShape,
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = if (recording) p.danger else p.surface2,
            contentColor = if (recording) p.accentInk else p.inkSoft,
            disabledContainerColor = p.surface2,
            disabledContentColor = p.inkFaint,
        ),
        modifier = Modifier.size(48.dp),
    ) {
        when {
            busy -> CircularProgressIndicator(strokeWidth = 2.dp, color = p.accent, modifier = Modifier.size(20.dp))
            recording -> Icon(Icons.Filled.Stop, contentDescription = stringResource(R.string.chat_stop_dictating))
            else -> Icon(Icons.Filled.Mic, contentDescription = stringResource(R.string.chat_dictate))
        }
    }
}

@Composable
private fun RecordingBar(st: MicState.Recording) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(p.danger))
        Text(
            if (st.engine == Engine.COMPUTER) stringResource(R.string.chat_listening_clock, Dictation.clock(st.samples)) else stringResource(R.string.chat_listening),
            style = MaterialTheme.typography.bodySmall,
            color = p.ink,
        )
        LinearProgressIndicator(
            progress = { st.level },
            color = p.accent,
            trackColor = p.surface2,
            modifier = Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp)),
        )
        Text(stringResource(R.string.chat_tap_when_done), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}
