package com.nekko.android.ui.settings

import androidx.compose.ui.platform.LocalResources
import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.security.SafetyExit
import com.nekko.android.ui.security.SafetyExitDialogs
import com.nekko.android.ui.security.rememberSafetyExits
import com.nekko.android.ui.security.safetyExits
import com.nekko.android.ui.theme.Nekko

/**
 * Settings → This computer (SK-8): the safety exits for the computer this
 * phone is connected to. Also in the connection banner's menu, so they are
 * one tap away while a chat runs.
 */
@Composable
fun ThisComputerSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val c by deps.repo.state.collectAsStateWithLifecycle()
    // Before the early return: after *Sign out this phone* there may be no computer left,
    // and the outcome still has to be said.
    val exits = rememberSafetyExits(deps.repo)
    val active = c.active
    if (active == null) {
        exits.outcome?.let { (text, tone) ->
            SectionHeader(stringResource(R.string.settings_this_computer))
            Notice(text, tone, Modifier.padding(horizontal = 16.dp))
        }
        return
    }
    SectionHeader(stringResource(R.string.settings_this_computer))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            safetyExits(c, exits, LocalResources.current).forEach { ExitRow(it) }
        }
        exits.outcome?.let { (text, tone) -> Notice(text, tone, Modifier.padding(top = 10.dp)) }
        Text(
            listOfNotNull(
                stringResource(R.string.settings_exits_footer),
                if (c.quitFromPhone) null else stringResource(R.string.settings_quit_off, active.name),
            ).joinToString(" "),
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
    SafetyExitDialogs(exits, active.name)
}

@Composable
private fun ExitRow(e: SafetyExit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = e.enabled, role = Role.Button, onClick = e.action)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val tint = when {
            !e.enabled -> p.inkFaint
            e.danger -> p.danger
            else -> p.inkSoft
        }
        Icon(e.icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f)) {
            Text(e.title, style = MaterialTheme.typography.bodyLarge, color = if (e.enabled) (if (e.danger) p.danger else p.ink) else p.inkFaint)
            Text(e.detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
    }
}
