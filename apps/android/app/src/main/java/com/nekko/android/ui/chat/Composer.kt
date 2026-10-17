package com.nekko.android.ui.chat

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
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
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
 * Prompt box: **+** on the left (dictation, an image from files, a photo from
 * the camera), the text, and Send on the right. While a run is going, sending
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
) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf(initialText.orEmpty()) }
    var sending by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    // The armed skill, by name: it survives rotation and is dropped if the computer no longer has it.
    var skillName by rememberSaveable { mutableStateOf<String?>(null) }
    val skill = skillName?.let { n -> skills.firstOrNull { it.name == n } }
    val menu = if (skill == null) SkillMenu.query(text)?.let { SkillMenu.match(skills, it) }.orEmpty() else emptyList()
    val photos = attach?.state?.photos.orEmpty()
    val addingPhotos = attach?.state?.busy == true
    val hasContent = text.isNotBlank() || skill != null || photos.isNotEmpty()
    // Send waits for photos still being read, so none are left behind.
    val canSend = hasContent && blocked == null && !sending && !addingPhotos
    val showStop = running && !hasContent && !addingPhotos
    var plusOpen by remember { mutableStateOf(false) }
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
            val (armed, value) = skill?.let { it to text.trim() } ?: SkillMenu.typed(text, skills) ?: (null to text.trim())
            val sentPhotos = attach?.take?.invoke().orEmpty()
            sending = true
            text = ""
            skillName = null
            error = null
            scope.launch {
                try {
                    onSend(value, armed, sentPhotos.map { it.dataUrl })
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    text = value // keep what they typed if it didn't go
                    skillName = armed?.name
                    attach?.restore?.invoke(sentPhotos)
                    error = e.message ?: "Couldn’t send that."
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
                Text(
                    if (queued.size == 1) "1 prompt queued after this run" else "${queued.size} prompts queued after this run",
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkFaint,
                )
                queued.takeLast(3).forEach { q ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Schedule, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(14.dp))
                        Text(q, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            mic?.let { m ->
                when (val st = m.state) {
                    is MicState.Recording -> RecordingBar(st)
                    is MicState.Transcribing -> Text(
                        if (st.engine == Engine.COMPUTER) "Transcribing on ${m.computerName}…" else "Transcribing…",
                        style = MaterialTheme.typography.bodySmall,
                        color = p.inkSoft,
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )
                    MicState.Idle -> Unit
                }
            }
            if (menu.isNotEmpty()) SkillList(menu) { picked ->
                skillName = picked.name
                text = ""
                error = null
            }
            skill?.let { SkillChip(it) { skillName = null } }
            if (attach != null && (photos.isNotEmpty() || addingPhotos)) PhotoStrip(photos, attach.state.adding, attach.onRemove)
            val note = blocked ?: error ?: mic?.error ?: attach?.state?.error
            if (note != null) {
                Text(
                    note,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (blocked != null) p.warning else p.danger,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(p.surface)
                    .border(1.dp, p.line, RoundedCornerShape(16.dp))
                    .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val recording = mic?.state is MicState.Recording
                val transcribing = mic?.state is MicState.Transcribing
                if (mic != null && (recording || transcribing)) {
                    // Dictating: + becomes the way to finish (■), as the mic button was.
                    MicButton(mic, onText = dictated)
                } else if (mic != null || attach != null) {
                    Box {
                        PlusButton(open = plusOpen) { plusOpen = true }
                        PlusMenu(
                            open = plusOpen,
                            onDismiss = { plusOpen = false },
                            onDictate = mic?.let { m -> { plusOpen = false; m.onTap(dictated) } },
                            attach = attach,
                            onPicked = { plusOpen = false; attach?.clearError?.invoke() },
                        )
                    }
                }
                BasicTextField(
                    value = text,
                    onValueChange = {
                        text = it
                        error = null
                    },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = p.ink),
                    cursorBrush = SolidColor(p.accent),
                    maxLines = 6,
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .padding(start = if (mic != null || attach != null) 0.dp else 8.dp, top = 12.dp, bottom = 12.dp)
                        .semantics { contentDescription = "Message" },
                    decorationBox = { inner ->
                        if (text.isEmpty()) {
                            Text(
                                when {
                                    skill != null -> "Add details for /${skill.name} (optional)"
                                    running -> "Queue a follow-up…"
                                    skills.isNotEmpty() -> "Message your computer, / for skills"
                                    else -> "Message your computer"
                                },
                                style = MaterialTheme.typography.bodyLarge,
                                color = p.inkFaint,
                            )
                        }
                        inner()
                    },
                )
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
                        Icon(Icons.Filled.Stop, contentDescription = "Stop")
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = if (running) "Queue" else "Send")
                    }
                }
            }
        }
    }
}

/** The `/` menu: the computer's skills matching what's typed after the slash. */
@Composable
private fun SkillList(skills: List<SkillSummary>, onPick: (SkillSummary) -> Unit) {
    val p = Nekko.palette
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 260.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(p.surface)
            .border(1.dp, p.line, RoundedCornerShape(12.dp))
            .verticalScroll(rememberScrollState())
            .semantics { contentDescription = "Skills on your computer" },
    ) {
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
private fun SkillChip(skill: SkillSummary, onClear: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(p.accentSoft)
            .padding(start = 10.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Filled.Extension, contentDescription = null, tint = p.accent, modifier = Modifier.size(16.dp))
        Text("/${skill.name}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = p.ink)
        IconButton(onClick = onClear, modifier = Modifier.size(36.dp)) {
            Icon(Icons.Filled.Close, contentDescription = "Remove skill /${skill.name}", tint = p.inkSoft, modifier = Modifier.size(16.dp))
        }
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
        Icon(Icons.Filled.Add, contentDescription = "Add")
    }
}

/** The **+** menu: dictation, an image from the phone's files, a photo from the camera. */
@Composable
private fun PlusMenu(
    open: Boolean,
    onDismiss: () -> Unit,
    onDictate: (() -> Unit)?,
    attach: AttachUi?,
    onPicked: () -> Unit,
) {
    val p = Nekko.palette
    val full = attach != null && attach.state.room == 0
    DropdownMenu(
        expanded = open,
        onDismissRequest = onDismiss,
        containerColor = p.surface,
        shape = RoundedCornerShape(14.dp),
    ) {
        if (onDictate != null) {
            DropdownMenuItem(
                text = { Text("Dictate", color = p.ink) },
                leadingIcon = { Icon(Icons.Filled.Mic, contentDescription = null, tint = p.inkSoft) },
                onClick = onDictate,
            )
        }
        if (attach != null) {
            val hint: @Composable (() -> Unit)? = if (full) {
                { Text("${PhotoTray.MAX_PHOTOS} max", style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
            } else null
            DropdownMenuItem(
                text = { Text("Image from files", color = if (full) p.inkFaint else p.ink) },
                leadingIcon = { Icon(Icons.Filled.AttachFile, contentDescription = null, tint = if (full) p.inkFaint else p.inkSoft) },
                trailingIcon = hint,
                enabled = !full,
                onClick = { onPicked(); attach.onPickFiles() },
            )
            attach.onTakePhoto?.let { take ->
                DropdownMenuItem(
                    text = { Text("Take photo", color = if (full) p.inkFaint else p.ink) },
                    leadingIcon = { Icon(Icons.Filled.PhotoCamera, contentDescription = null, tint = if (full) p.inkFaint else p.inkSoft) },
                    enabled = !full,
                    onClick = { onPicked(); take() },
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
            Box(Modifier.size(64.dp)) {
                Image(
                    photo.preview,
                    contentDescription = "Photo ${i + 1}",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).border(1.dp, p.line, RoundedCornerShape(10.dp)),
                )
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .size(40.dp)
                        .clip(CircleShape)
                        .clickable { onRemove(photo.id) }
                        .semantics { contentDescription = "Remove photo ${i + 1}" },
                    contentAlignment = Alignment.TopEnd,
                ) {
                    Box(Modifier.padding(3.dp).size(20.dp).clip(CircleShape).background(p.ink.copy(alpha = 0.72f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Close, contentDescription = null, tint = p.paper, modifier = Modifier.size(14.dp))
                    }
                }
            }
        }
        repeat(adding) {
            Box(
                Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).background(p.surface2).semantics { contentDescription = "Adding photo" },
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
            recording -> Icon(Icons.Filled.Stop, contentDescription = "Stop dictating")
            else -> Icon(Icons.Filled.Mic, contentDescription = "Dictate")
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
            if (st.engine == Engine.COMPUTER) "Listening · ${Dictation.clock(st.samples)}" else "Listening…",
            style = MaterialTheme.typography.bodySmall,
            color = p.ink,
        )
        LinearProgressIndicator(
            progress = { st.level },
            color = p.accent,
            trackColor = p.surface2,
            modifier = Modifier.weight(1f).height(4.dp).clip(RoundedCornerShape(2.dp)),
        )
        Text("Tap ■ when done", style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
    }
}
