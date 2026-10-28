package com.nekko.android.ui.settings

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.SimpleItem
import com.nekko.android.data.SimpleMode
import com.nekko.android.data.SimpleVisibility
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.simple.TextSegments
import com.nekko.android.ui.theme.Nekko
import kotlinx.coroutines.delay

/** Settings → Simple mode: the row that opens [SimpleModeScreen]. */
@Composable
fun SimpleModeSection(deps: SettingsDeps) {
    val raw by deps.phonePrefs.flow(SimpleMode.CHOICES).collectAsStateWithLifecycle()
    val changed = remember(raw) { SimpleMode.parse(raw).size }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        NCard {
            SettingsRow(
                title = "Simple mode",
                detail = if (changed == 0) "What Simple and Expert show" else "What Simple and Expert show · $changed changed",
                icon = Icons.Filled.Tune,
                onClick = { deps.open(Routes.SIMPLE_MODE) },
            )
        }
    }
}

/**
 * Controls the catalogue lists that this app does not have yet: a choice for them would do
 * nothing here, so the screen leaves them out (they stay in the catalogue to keep the ids in step).
 */
private val NOT_ON_ANDROID = setOf("ph-policy")

/**
 * One drawn piece of an area's preview: a catalogue control when [id] is set, else a fixed part
 * of the screen. [gauges] draws the minimal monitor: thin rings with their percentages.
 */
private data class Part(val text: String, val id: String? = null, val gauges: Boolean = false)

/** One line of a preview; [spread] pushes its parts to the edges, [divider] draws the hairline under it. */
private data class Line(val parts: List<Part>, val spread: Boolean = false, val divider: Boolean = false)

private fun line(vararg parts: Part, spread: Boolean = false, divider: Boolean = false) = Line(parts.toList(), spread, divider)

/** The minimal monitor as the slim row draws it. */
private val MINI_MONITOR = Part("CPU 12%  Memory 41%  GPU 30%  1 model", "hardware", gauges = true)

/** A rough drawing of each area, labelled with the real control names. */
private val PREVIEWS: Map<String, List<Line>> = mapOf(
    "Chat · header" to listOf(
        line(Part("Back"), Part("Fix the login bug"), Part("Changes", "changes"), Part("More"), spread = true),
        line(Part("Opus 5.5 · Studio Mac", "ph-subtitle"), spread = true),
        line(Part("Mode switch"), MINI_MONITOR, spread = true, divider = true),
    ),
    "Chat · message box" to listOf(
        line(Part("Add"), Part("Message your computer"), Part("Send")),
        line(Part("Effort dial", "effort"), Part("Opus 5.5", "model"), Part("48k / 200k tokens", "context")),
    ),
    "Chat · conversation" to listOf(
        line(Part("Make the tests pass")),
        line(Part("Show reasoning", "thinking"), Part("Ran npm test", "thinking")),
        line(Part("All 42 tests pass now.")),
        line(Part("PR #42 · Open", "ph-git")),
    ),
    "Agents wall" to listOf(
        line(Part("New agent"), Part("Terminal", "terminal"), Part("Dictate"), Part("Image from files")),
    ),
    "Phone · chats list" to listOf(
        line(Part("Chats"), Part("Computers"), Part("Settings"), spread = true),
        line(Part("Mode switch"), MINI_MONITOR, spread = true, divider = true),
        line(Part("Fix the login bug")),
        line(Part("Plan the trip")),
        line(Part("Monitors · hardware and loaded models", "ph-monitors")),
    ),
)

private fun label(v: SimpleVisibility) = when (v) {
    SimpleVisibility.SHOW -> "Show"
    SimpleVisibility.EXPERT -> "Expert only"
    SimpleVisibility.HIDE -> "Hide"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimpleModeScreen(prefs: PhonePrefs, onBack: () -> Unit) {
    val p = Nekko.palette
    val raw by prefs.flow(SimpleMode.CHOICES).collectAsStateWithLifecycle()
    val choices = remember(raw) { SimpleMode.parse(raw) }
    val simpleName = stringResource(R.string.mode_simple)
    val expertName = stringResource(R.string.mode_expert)
    var previewExpert by rememberSaveable { mutableStateOf(false) }
    // The control last changed, outlined in its preview for a moment.
    var flash by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(flash) { if (flash != null) { delay(1_200); flash = null } }
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text("Simple mode") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Simple keeps Nekko calm for everyday use. Everything still works; these controls just stay out of sight.",
                    style = MaterialTheme.typography.bodyLarge, color = p.inkSoft,
                )
                Text("Preview", style = MaterialTheme.typography.labelMedium, color = p.inkFaint)
                TextSegments(
                    listOf(false, true), previewExpert, { previewExpert = it },
                    label = { if (it) expertName else simpleName },
                    describe = { "Preview ${if (it) expertName else simpleName}" },
                    modifier = Modifier.testTag("simple.preview"),
                )
            }
            SimpleMode.AREAS.forEach { (area, all) ->
                val items = all.filter { it.id !in NOT_ON_ANDROID }
                if (items.isEmpty()) return@forEach
                SectionHeader(area)
                Column(Modifier.padding(horizontal = 16.dp)) {
                    NCard {
                        AreaPreview(PREVIEWS[area].orEmpty(), previewExpert, choices, flash)
                        items.forEach { item ->
                            HorizontalDivider(color = p.line)
                            ChoiceRow(item, SimpleMode.visibility(item.id, choices)) { v ->
                                prefs.set(SimpleMode.CHOICES, SimpleMode.encode(SimpleMode.with(choices, item.id, v)))
                                flash = item.id
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.size(16.dp))
            OutlinedButton(
                onClick = { prefs.reset(SimpleMode.CHOICES) },
                enabled = choices.isNotEmpty(),
                modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
            ) { Text("Reset to defaults") }
        }
    }
}

@Composable
private fun ChoiceRow(item: SimpleItem, value: SimpleVisibility, onChange: (SimpleVisibility) -> Unit) {
    val p = Nekko.palette
    Column(Modifier.fillMaxWidth().testTag("simple.row.${item.id}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column {
            Text(item.label, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(item.hint, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
            if (item.id in SimpleMode.LOCAL_MODEL_IDS && value == SimpleVisibility.EXPERT) {
                Text(SimpleMode.LOCAL_MODEL_NOTE + ".", style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
            }
        }
        TextSegments(
            SimpleVisibility.entries, value, onChange, label = ::label,
            describe = { "${item.label}: ${label(it)}" },
        )
    }
}

/**
 * The area drawn as rounded chips in the theme's colours: a control hidden in the previewed
 * mode keeps its place with a dashed outline and faded, like a design prototype.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AreaPreview(lines: List<Line>, expert: Boolean, choices: Map<String, SimpleVisibility>, flash: String?) {
    val p = Nekko.palette
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.paper).border(1.dp, p.line, RoundedCornerShape(12.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        lines.forEach { line ->
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = if (line.spread) Arrangement.SpaceBetween else Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                line.parts.forEach { part -> PreviewPart(part, expert, choices, flash) }
            }
            if (line.divider) HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        }
    }
}

@Composable
private fun PreviewPart(part: Part, expert: Boolean, choices: Map<String, SimpleVisibility>, flash: String?) {
    val p = Nekko.palette
    // A preview assumes no local model is loaded; the rows say what one changes.
    val shown = part.id == null || SimpleMode.shown(part.id, expert, choices)
    val lit = part.id != null && part.id == flash
    val edge by animateColorAsState(if (lit) p.accent else if (shown) p.line else p.inkFaint, label = "preview-edge")
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .semantics(mergeDescendants = true) { if (part.id != null) contentDescription = "${part.text}, ${if (shown) "shown" else "hidden"}" }
            .alpha(if (shown) 1f else 0.4f)
            .then(
                if (shown) Modifier.clip(shape).background(if (part.id == null) p.surface else p.surface2).border(if (lit) 2.dp else 1.dp, edge, shape)
                else Modifier.drawBehind {
                    drawRoundRect(
                        edge, cornerRadius = CornerRadius(8.dp.toPx()),
                        style = Stroke(if (lit) 2.dp.toPx() else 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
                    )
                },
            )
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (part.gauges) {
            listOf(0.12f to "12%", 0.41f to "41%", 0.3f to "30%").forEach { (f, t) ->
                Canvas(Modifier.size(10.dp)) {
                    val w = 1.5.dp.toPx()
                    val arc = Size(size.width - w, size.height - w)
                    drawArc(p.line, 0f, 360f, false, Offset(w / 2, w / 2), arc, style = Stroke(w))
                    drawArc(p.accent, -90f, 360f * f, false, Offset(w / 2, w / 2), arc, style = Stroke(w))
                }
                Text(t, style = MaterialTheme.typography.labelSmall, color = p.inkSoft)
            }
            Text("1 model", style = MaterialTheme.typography.labelSmall, color = p.inkSoft)
        } else {
            Text(part.text, style = MaterialTheme.typography.labelMedium, color = if (part.id == null) p.inkFaint else p.ink)
        }
    }
}
