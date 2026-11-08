package com.nekko.android.ui.settings

import com.nekko.android.ui.components.PermissionIcon
import com.nekko.protocol.PcSettings.ChatMode

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
import com.nekko.android.data.SimpleContext
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
                title = stringResource(R.string.simple_mode_title),
                detail = if (changed == 0) stringResource(R.string.simple_mode_detail) else stringResource(R.string.simple_mode_detail_changed, changed),
                icon = Icons.Filled.Tune,
                onClick = { deps.open(Routes.SIMPLE_MODE) },
            )
        }
    }
}

/** What Settings calls each control and says about it. The catalogue itself holds no words. */
private val ITEM_TEXT: Map<String, Pair<Int, Int>> = mapOf(
    "changes" to (R.string.simple_item_changes to R.string.simple_hint_changes),
    "hardware" to (R.string.simple_item_hardware to R.string.simple_hint_hardware),
    "ph-subtitle" to (R.string.simple_item_subtitle to R.string.simple_hint_subtitle),
    "model" to (R.string.simple_item_model to R.string.simple_hint_model),
    "effort" to (R.string.simple_item_effort to R.string.simple_hint_effort),
    "asks" to (R.string.permission_simple_always_ask to R.string.simple_hint_asks),
    "context" to (R.string.simple_item_context to R.string.simple_hint_context),
    "run-settings" to (R.string.simple_item_run to R.string.simple_hint_run),
    "thinking" to (R.string.simple_item_thinking to R.string.simple_hint_thinking),
    "pr-status" to (R.string.simple_item_pr to R.string.simple_hint_pr),
    "ph-git" to (R.string.simple_item_git to R.string.simple_hint_git),
    "ph-monitors" to (R.string.simple_item_monitors to R.string.simple_hint_monitors),
)

private val AREA_TEXT = mapOf(
    SimpleMode.HEADER to R.string.simple_area_header,
    SimpleMode.BOX to R.string.simple_area_box,
    SimpleMode.CONVERSATION to R.string.simple_area_conversation,
    SimpleMode.CHATS to R.string.simple_area_chats,
)

/**
 * One drawn piece of an area's preview: a catalogue control when [id] is set, else a fixed part
 * of the screen. [gauges] draws the minimal monitor: thin rings with their percentages. [name] is
 * for product names, which stay as they are in every language.
 */
private data class Part(val text: Int = 0, val id: String? = null, val gauges: Boolean = false, val name: String? = null)

/** One line of a preview; [spread] pushes its parts to the edges, [divider] draws the hairline under it. */
private data class Line(val parts: List<Part>, val spread: Boolean = false, val divider: Boolean = false)

private fun line(vararg parts: Part, spread: Boolean = false, divider: Boolean = false) = Line(parts.toList(), spread, divider)

/** The minimal monitor as the slim row draws it. */
private val MINI_MONITOR = Part(R.string.simple_part_gauges, "hardware", gauges = true)

/** A rough drawing of each area, labelled with the real control names. */
private val PREVIEWS: Map<String, List<Line>> = mapOf(
    SimpleMode.HEADER to listOf(
        line(Part(R.string.simple_part_back), Part(R.string.simple_part_title), Part(R.string.simple_files_changed_one, "changes"), Part(R.string.simple_part_more), spread = true),
        line(Part(id = "ph-subtitle", name = "Opus 5.5 · Studio Mac"), spread = true),
        line(Part(R.string.simple_part_mode), MINI_MONITOR, spread = true, divider = true),
    ),
    SimpleMode.BOX to listOf(
        line(Part(R.string.simple_part_add), Part(R.string.simple_part_message), Part(R.string.simple_part_send)),
        line(Part(R.string.simple_part_dial, "effort"), Part(id = "model", name = "Opus 5.5"), Part(R.string.permission_simple_always_ask, "asks"), Part(R.string.simple_part_tokens, "context")),
        line(Part(R.string.simple_item_run, "run-settings")),
    ),
    SimpleMode.CONVERSATION to listOf(
        line(Part(R.string.simple_part_goal)),
        line(Part(R.string.simple_part_reasoning, "thinking"), Part(R.string.simple_part_ran, "thinking")),
        line(Part(R.string.simple_part_passed)),
        line(Part(R.string.simple_part_pr, "pr-status"), Part(R.string.simple_item_git, "ph-git")),
    ),
    SimpleMode.CHATS to listOf(
        line(Part(R.string.simple_part_chats), Part(R.string.chats_computers), Part(R.string.simple_part_settings), spread = true),
        line(Part(R.string.simple_part_mode), MINI_MONITOR, spread = true, divider = true),
        line(Part(R.string.simple_part_title)),
        line(Part(R.string.simple_part_trip)),
        line(Part(R.string.simple_part_monitors, "ph-monitors")),
    ),
)

/** What a choice says for this item: Show pins a monitor on, so it reads Always there. */
private fun choiceRes(item: SimpleItem, v: SimpleVisibility) = when (v) {
    SimpleVisibility.SHOW -> if (item.default == SimpleVisibility.AUTO) R.string.simple_choice_always else R.string.simple_choice_show
    SimpleVisibility.EXPERT -> R.string.simple_choice_expert
    SimpleVisibility.HIDE -> R.string.simple_choice_hide
    SimpleVisibility.AUTO -> R.string.simple_choice_auto
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimpleModeScreen(prefs: PhonePrefs, onBack: () -> Unit) {
    val p = Nekko.palette
    val raw by prefs.flow(SimpleMode.CHOICES).collectAsStateWithLifecycle()
    val choices = remember(raw) { SimpleMode.parse(raw) }
    val simpleName = stringResource(R.string.mode_simple)
    val expertName = stringResource(R.string.mode_expert)
    val previewWords = stringResource(R.string.simple_preview_mode)
    var previewExpert by rememberSaveable { mutableStateOf(false) }
    // The control last changed, outlined in its preview for a moment.
    var flash by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(flash) { if (flash != null) { delay(1_200); flash = null } }
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.simple_mode_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chats_back)) } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(R.string.simple_intro),
                    style = MaterialTheme.typography.bodyLarge, color = p.inkSoft,
                )
                Text(stringResource(R.string.simple_preview), style = MaterialTheme.typography.labelMedium, color = p.inkFaint)
                TextSegments(
                    listOf(false, true), previewExpert, { previewExpert = it },
                    label = { if (it) expertName else simpleName },
                    describe = { previewWords.format(if (it) expertName else simpleName) },
                    modifier = Modifier.testTag("simple.preview"),
                )
            }
            SimpleMode.AREAS.forEach { (area, items) ->
                SectionHeader(AREA_TEXT[area]?.let { stringResource(it) } ?: area)
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
            ) { Text(stringResource(R.string.simple_reset)) }
        }
    }
}

@Composable
private fun ChoiceRow(item: SimpleItem, value: SimpleVisibility, onChange: (SimpleVisibility) -> Unit) {
    val p = Nekko.palette
    val name = ITEM_TEXT[item.id]?.let { stringResource(it.first) } ?: item.id
    val words = SimpleMode.options(item).associateWith { stringResource(choiceRes(item, it)) }
    Column(Modifier.fillMaxWidth().testTag("simple.row.${item.id}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column {
            Text(name, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(ITEM_TEXT[item.id]?.let { stringResource(it.second) }.orEmpty(), style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        TextSegments(
            SimpleMode.options(item), value, onChange, label = { words.getValue(it) },
            describe = { "$name: ${words.getValue(it)}" },
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
    // A preview draws a chat with changes and a pull request, and no local model running.
    val shown = part.id == null || SimpleMode.shown(part.id, expert, choices, SimpleContext(changes = true, pr = true))
    val text = part.name ?: stringResource(part.text)
    val spoken = stringResource(if (shown) R.string.simple_part_shown else R.string.simple_part_hidden, text)
    val lit = part.id != null && part.id == flash
    val edge by animateColorAsState(if (lit) p.accent else if (shown) p.line else p.inkFaint, label = "preview-edge")
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .semantics(mergeDescendants = true) { if (part.id != null) contentDescription = spoken }
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
        if (part.id == "asks") PermissionIcon(ChatMode.ASK)
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
            Text(stringResource(R.string.simple_one_model), style = MaterialTheme.typography.labelSmall, color = p.inkSoft)
        } else {
            Text(text, style = MaterialTheme.typography.labelMedium, color = if (part.id == null) p.inkFaint else p.ink)
        }
    }
}
