package com.nekko.android.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.Image
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.nekko.android.chat.ImageAttachments
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Prompt box. While a run is going, sending queues the prompt on the computer
 * and an empty box turns Send into Stop. Typing `/` offers the computer's
 * skills; a picked skill shows as a chip and the box becomes its input.
 */
@Composable
fun Composer(
    running: Boolean,
    blocked: String?,
    queued: List<String>,
    /** Text, the armed skill and photos (JPEG data URLs); throws when it didn't go. */
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
    // Photos are held in memory only (data URLs are too big for saved state); rotation drops them.
    var images by remember { mutableStateOf<List<String>>(emptyList()) }
    var loadingPhotos by remember { mutableStateOf(false) }
    val resolver = LocalContext.current.contentResolver
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(ImageAttachments.MAX)) { uris ->
        if (uris.isNotEmpty()) {
            loadingPhotos = true
            scope.launch {
                try {
                    val loaded = ImageAttachments.load(resolver, uris)
                    images = loaded
                    error = if (loaded.size < uris.size) "Some photos couldn’t be read." else null
                } finally {
                    loadingPhotos = false
                }
            }
        }
    }
    val canSend = (text.isNotBlank() || skill != null || images.isNotEmpty()) && blocked == null && !sending && !loadingPhotos
    val showStop = running && text.isBlank()
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
            val photos = images
            sending = true
            text = ""
            skillName = null
            images = emptyList()
            error = null
            scope.launch {
                try {
                    onSend(value, armed, photos)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    text = value // keep what they typed if it didn't go
                    skillName = armed?.name
                    images = photos
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
            if (images.isNotEmpty() || loadingPhotos) PhotosChip(images.size, loadingPhotos) { images = emptyList() }
            val note = blocked ?: error ?: mic?.error
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
                    .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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
                        .padding(vertical = 12.dp)
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
                IconButton(
                    onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    enabled = !sending && !loadingPhotos,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(Icons.Filled.AddPhotoAlternate, contentDescription = "Add photos", tint = p.inkSoft)
                }
                if (mic != null) MicButton(mic, onText = dictated)
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

/** The microphone as the composer sees it; the chat screen builds it from [DictationController]. */
class MicUi(
    val state: MicState,
    val error: String?,
    val computerName: String,
    /** Tap: start, or stop and transcribe. The screen asks for the microphone permission first. */
    val onTap: (onText: (String) -> Unit) -> Unit,
)

/** The photos going with the next prompt: how many, and a way to drop them. */
@Composable
private fun PhotosChip(count: Int, loading: Boolean, onClear: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(p.surface2)
            .padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(strokeWidth = 2.dp, color = p.accent, modifier = Modifier.size(14.dp))
            Text("Preparing photos…", style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(vertical = 14.dp, horizontal = 4.dp))
        } else {
            Icon(Icons.Filled.Image, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(16.dp))
            Text(if (count == 1) "1 photo" else "$count photos", style = MaterialTheme.typography.bodySmall, color = p.ink)
            IconButton(onClick = onClear, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "Remove photos", tint = p.inkSoft, modifier = Modifier.size(18.dp))
            }
        }
    }
}

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
