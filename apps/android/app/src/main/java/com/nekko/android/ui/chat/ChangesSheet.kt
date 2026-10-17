package com.nekko.android.ui.chat

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.PhoneChanges
import kotlinx.coroutines.CancellationException

/**
 * What the agent changed in a chat, read only. The computer works out the diff
 * and caps it (`phoneChangesView`); a phone can't accept, revert or open
 * anything else, and secret files arrive as a count only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangesSheet(load: suspend () -> PhoneChanges, onDismiss: () -> Unit) {
    val p = Nekko.palette
    var changes by remember { mutableStateOf<PhoneChanges?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        try {
            changes = load()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Couldn’t load changes."
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.paper) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Changes", style = MaterialTheme.typography.titleMedium, color = p.ink, modifier = Modifier.weight(1f).semantics { heading() })
            TextButton(onClick = { attempt++ }) { Text("Refresh") }
        }
        val c = changes
        when {
            c == null && error != null -> Notice("Couldn’t load changes", error!!)
            c == null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            c.files.isEmpty() -> Notice("No changes", "The agent hasn’t changed any files in this chat.")
            else -> LazyColumn(
                Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { Text(summary(c), style = MaterialTheme.typography.bodySmall, color = p.inkSoft) }
                items(c.files, key = { it.path }) { FileChange(it) }
                if (c.omittedFiles > 0) {
                    item {
                        Text(
                            "${c.omittedFiles} more ${if (c.omittedFiles == 1) "file" else "files"} changed. See them on your computer.",
                            style = MaterialTheme.typography.bodySmall, color = p.inkFaint,
                        )
                    }
                }
                item { Text("Read only. Accept or revert changes on your computer.", style = MaterialTheme.typography.labelSmall, color = p.inkFaint) }
            }
        }
    }
}

private fun summary(c: PhoneChanges): String {
    val n = c.files.size + c.omittedFiles
    return "$n ${if (n == 1) "file" else "files"} · +${c.linesAdded} −${c.linesRemoved}"
}

@Composable
private fun Notice(title: String, body: String) {
    val p = Nekko.palette
    Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = p.ink)
        Text(body, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}

@Composable
private fun FileChange(file: PhoneChanges.File) {
    val p = Nekko.palette
    var open by rememberSaveable(file.path) { mutableStateOf(true) }
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().background(p.surface, shape).border(1.dp, p.line, shape)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { open = !open }.padding(horizontal = 12.dp)
                .clearAndSetSemantics {
                    contentDescription = "${file.path}, ${if (file.added) "new file, " else ""}${file.linesAdded} added, ${file.linesRemoved} removed"
                    stateDescription = if (open) "Expanded" else "Collapsed"
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, contentDescription = null, tint = p.inkFaint)
            Text(
                file.path, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = p.ink,
                maxLines = 1, overflow = TextOverflow.StartEllipsis, modifier = Modifier.weight(1f, fill = false),
            )
            if (file.added) Text("new", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = p.success)
            Spacer(Modifier.weight(1f))
            Text("+${file.linesAdded}", style = MaterialTheme.typography.labelMedium, color = p.success)
            Text("−${file.linesRemoved}", style = MaterialTheme.typography.labelMedium, color = p.danger)
        }
        if (open) {
            HorizontalDivider(color = p.line)
            when (val s = file.shown) {
                PhoneChanges.Shown.Diff ->
                    if (file.hunks.isEmpty()) {
                        Note("Empty file.")
                    } else {
                        Column(Modifier.fillMaxWidth().background(p.code).horizontalScroll(rememberScrollState()).padding(vertical = 6.dp)) {
                            file.hunks.forEachIndexed { i, h ->
                                if (i > 0) {
                                    Text(
                                        "⋯", fontFamily = FontFamily.Monospace, color = p.inkFaint,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp).semantics { contentDescription = "Unchanged lines skipped" },
                                    )
                                }
                                h.lines.forEach { DiffLine(it) }
                            }
                        }
                    }
                PhoneChanges.Shown.Hidden -> Note("May hold secrets, so it isn’t shown on phones.")
                PhoneChanges.Shown.Binary -> Note("Not a text file.")
                is PhoneChanges.Shown.TooLarge -> Note("Too big to show here (${s.lines} changed lines). See it on your computer.")
            }
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = Modifier.padding(12.dp))
}

@Composable
private fun DiffLine(line: PhoneChanges.Line) {
    val p = Nekko.palette
    val (mark, tint, bg) = when (line.kind) {
        PhoneChanges.Kind.ADDED -> Triple("+", p.success, p.successSoft)
        PhoneChanges.Kind.REMOVED -> Triple("−", p.danger, p.dangerSoft)
        PhoneChanges.Kind.SAME -> Triple(" ", p.inkFaint, Color.Transparent)
    }
    val kind = when (line.kind) {
        PhoneChanges.Kind.ADDED -> "Added"
        PhoneChanges.Kind.REMOVED -> "Removed"
        PhoneChanges.Kind.SAME -> "Unchanged"
    }
    Row(
        Modifier.background(bg).padding(horizontal = 12.dp, vertical = 1.dp)
            .clearAndSetSemantics { contentDescription = "$kind line ${line.number}: ${line.text.ifEmpty { "blank" }}" },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("${line.number}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = p.inkFaint, modifier = Modifier.widthIn(min = 28.dp))
        Text(mark, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = tint)
        Text(line.text.ifEmpty { " " }, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = p.ink, softWrap = false)
    }
}
