package com.nekko.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Monitor
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.phone.PhoneChats
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.settings.AppearanceSection
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.settings.SettingsRow
import com.nekko.android.ui.simple.LocalSimple
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.Channels
import com.nekko.protocol.PhoneTone
import com.nekko.protocol.RelayState
import com.nekko.protocol.SkillSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The page's tabs, as on the iPhone; Connectors joins them with its own page (#2109). */
private enum class CustomizeTab(val label: Int, val tag: String) {
    EXPERIENCE(R.string.customize_tab_experience, "customize.Experience"),
    SKILLS(R.string.customize_tab_skills, "customize.Skills"),
}

/**
 * Customize (the iPhone's CustomizeView, #2426): how the app shows agents' work (Simple or
 * Detailed, kept on this phone), the tone of models running on this phone, the look, and the
 * connected computer's skills. Nothing here grants tool access, and computer-hosted agents keep
 * that computer's tone and standing instructions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomizeScreen(deps: SettingsDeps, phone: PhoneChats?, onBack: () -> Unit) {
    val p = Nekko.palette
    var tab by rememberSaveable { mutableStateOf(CustomizeTab.EXPERIENCE) }
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.customize_title)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.settings_back)) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            // The tabs: capsules across the top, Experience first.
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CustomizeTab.entries.forEach { t ->
                    val on = t == tab
                    Box(
                        Modifier
                            .heightIn(min = 44.dp)
                            .background(if (on) p.accent else p.surface2, RoundedCornerShape(999.dp))
                            .clickable(role = Role.Tab) { tab = t }
                            .semantics { selected = on }
                            .padding(horizontal = 18.dp)
                            .testTag(t.tag),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(stringResource(t.label), style = MaterialTheme.typography.labelLarge, color = if (on) p.accentInk else p.ink)
                    }
                }
            }
            when (tab) {
                CustomizeTab.EXPERIENCE -> Experience(deps, phone)
                CustomizeTab.SKILLS -> Skills(deps)
            }
        }
    }
}

@Composable
private fun Experience(deps: SettingsDeps, phone: PhoneChats?) {
    val p = Nekko.palette
    val simple = LocalSimple.current
    val c by deps.repo.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("customize.experience")) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.customize_intro_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = p.ink)
            Text(stringResource(R.string.customize_intro), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
        }

        // Agent output: the same choice as the chat list's and the chat's menus.
        SectionHeader(stringResource(R.string.customize_output))
        Column(Modifier.padding(horizontal = 16.dp)) {
            NCard {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(12.dp).testTag("mode.switch")) {
                    listOf(false to R.string.mode_simple, true to R.string.mode_expert).forEachIndexed { i, (expert, label) ->
                        SegmentedButton(
                            selected = simple.expert == expert,
                            onClick = { if (simple.expert != expert) simple.setExpert(expert) },
                            shape = SegmentedButtonDefaults.itemShape(i, 2),
                            modifier = Modifier.testTag(if (expert) "mode.switch.detailed" else "mode.switch.simple"),
                        ) { Text(stringResource(label)) }
                    }
                }
                HorizontalDivider(color = p.line)
                SettingsRow(stringResource(R.string.customize_visible_controls), icon = Icons.Outlined.Tune, onClick = { deps.open(Routes.SIMPLE_MODE) })
            }
            Footer(stringResource(R.string.customize_output_footer))
        }

        // Tone of the models running on this phone; the computer's agents keep that computer's.
        SectionHeader(stringResource(R.string.customize_phone_chats))
        Column(Modifier.padding(horizontal = 16.dp)) {
            NCard { TonePicker(phone) }
            Footer(stringResource(R.string.customize_tone_footer))
        }

        // The look: the same rows as Settings → Appearance.
        AppearanceSection(deps)

        SectionHeader(stringResource(R.string.customize_how_agents_work))
        Column(Modifier.padding(horizontal = 16.dp)) {
            NCard {
                SettingsRow(stringResource(R.string.customize_behavior), icon = Icons.Outlined.Shield, onClick = { deps.open(Routes.SETTINGS) })
                if (c.computers.isNotEmpty()) {
                    HorizontalDivider(color = p.line)
                    SettingsRow(stringResource(R.string.chats_monitors), icon = Icons.Outlined.Monitor, onClick = { deps.open(Routes.MONITORS) })
                }
            }
            Footer(stringResource(R.string.customize_how_footer))
        }
        Spacer(Modifier.size(32.dp))
    }
}

/** The tone for models running on this phone, as a menu: Default, Friendly, Professional, Concise, Explanatory. */
@Composable
private fun TonePicker(phone: PhoneChats?) {
    val p = Nekko.palette
    val scope = rememberCoroutineScope()
    val tone = phone?.state?.collectAsStateWithLifecycle()?.value?.tone ?: PhoneTone.STANDARD
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .clickable(enabled = phone != null, role = Role.DropdownList) { open = true }
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .testTag("customize.tone"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.customize_tone), style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
            Text(stringResource(toneName(tone)), style = MaterialTheme.typography.bodyMedium, color = p.accent)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            PhoneTone.entries.forEach { t ->
                DropdownMenuItem(
                    text = { Text(stringResource(toneName(t))) },
                    trailingIcon = { Icon(Icons.Outlined.Check, contentDescription = null, tint = if (t == tone) p.accent else androidx.compose.ui.graphics.Color.Transparent) },
                    onClick = { open = false; scope.launch { phone?.setTone(t) } },
                    modifier = Modifier.semantics { selected = t == tone }.testTag("customize.tone.${t.wire}"),
                )
            }
        }
    }
}

private fun toneName(t: PhoneTone): Int = when (t) {
    PhoneTone.STANDARD -> R.string.tone_default
    PhoneTone.FRIENDLY -> R.string.tone_friendly
    PhoneTone.PROFESSIONAL -> R.string.tone_professional
    PhoneTone.CONCISE -> R.string.tone_concise
    PhoneTone.EXPLANATORY -> R.string.tone_explanatory
}

@Composable
private fun Footer(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = Nekko.palette.inkSoft, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
}

/** What the Skills tab shows: still asking, the computer's list, or why there is none. */
private sealed interface SkillsLoad {
    data object Loading : SkillsLoad
    data class Loaded(val skills: List<SkillSummary>) : SkillsLoad
    data object Unreachable : SkillsLoad
}

/**
 * The active computer's skills (`skills:runnable`), to run with /name in a chat. Read-only, as on
 * the iPhone; reloaded when another computer becomes active, and on a pull down.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Skills(deps: SettingsDeps) {
    val p = Nekko.palette
    val c by deps.repo.state.collectAsStateWithLifecycle()
    var load by remember { mutableStateOf<SkillsLoad>(SkillsLoad.Loading) }
    var reloads by remember { mutableIntStateOf(0) }
    var pulling by remember { mutableStateOf(false) }
    val online = c.conn == RelayState.ONLINE
    LaunchedEffect(c.activeId, online, reloads) {
        if (load !is SkillsLoad.Loaded) load = SkillsLoad.Loading
        load = try {
            if (!online) SkillsLoad.Unreachable
            else SkillsLoad.Loaded(SkillSummary.list(deps.repo.caller.call(Channels.SKILLS_RUNNABLE)).sortedBy { it.name.lowercase() })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            SkillsLoad.Unreachable
        }
        pulling = false
    }
    PullToRefreshBox(isRefreshing = pulling, onRefresh = { pulling = true; reloads++ }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().testTag("customize.skills")) {
            item {
                Column(Modifier.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.customize_tab_skills), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = p.ink)
                    Text(stringResource(R.string.customize_skills_intro), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                }
            }
            when (val l = load) {
                SkillsLoad.Loading -> item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) } }
                SkillsLoad.Unreachable -> item {
                    Text(stringResource(R.string.customize_skills_offline), color = p.warning, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp).testTag("customize.skills.offline"))
                }
                is SkillsLoad.Loaded -> if (l.skills.isEmpty()) item {
                    Text(stringResource(R.string.customize_skills_none), color = p.inkSoft, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 20.dp))
                } else items(l.skills, key = { it.name }) { s -> SkillRow(s) }
            }
        }
    }
}

@Composable
private fun SkillRow(s: SkillSummary) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp).testTag("customize.skill.${s.name}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(44.dp).background(p.surface2, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.AutoFixHigh, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(s.name, style = MaterialTheme.typography.titleSmall, color = p.ink)
            if (s.description.isNotBlank()) Text(s.description, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
    }
}
