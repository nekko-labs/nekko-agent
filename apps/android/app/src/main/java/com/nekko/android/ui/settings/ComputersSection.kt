package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.ComputerIcon
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.computerIconRes
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState

/**
 * Settings → Computers, the first group (#2940, the iPhone's #2929): each paired computer as an
 * avatar row that opens its page, **Add a computer** with a plus, and **Manage computers** for the
 * list with rename, switch and forget.
 */
@Composable
fun ComputersSection(deps: SettingsDeps) {
    val c by deps.repo.state.collectAsStateWithLifecycle()
    SectionHeader(stringResource(R.string.settings_computers))
    Column(Modifier.padding(horizontal = 16.dp)) {
        c.computers.forEach { pc ->
            ComputerAvatarRow(pc, c) { deps.open(Routes.computer(pc.id)) }
        }
        PlusRow(stringResource(R.string.settings_add_computer), Modifier.testTag("settings.addComputer")) { deps.open(Routes.pair()) }
        QuietLinkRow(stringResource(R.string.settings_manage_computers), Icons.Outlined.Computer, computersDetailText(c), Modifier.testTag("settings.computers")) { deps.open(Routes.COMPUTERS) }
    }
}

/** A computer as an avatar row: its icon, a dot for whether it can be reached, its name and "Online · Internet relay". */
@Composable
internal fun ComputerAvatarRow(pc: Computer, c: ComputersState, onClick: () -> Unit) {
    val p = Nekko.palette
    val state = c.connOf(pc.id)
    val dot = when (state) {
        RelayState.ONLINE -> p.success
        RelayState.CONNECTING -> p.running
        RelayState.OFFLINE -> p.warning
        RelayState.DENIED -> p.danger
        RelayState.IDLE -> p.inkFaint
    }
    // The active computer's route in use; another computer's paired address.
    val route = RelayRoute.of((if (pc.id == c.activeId) c.route else null) ?: pc.relayUrl)
    AvatarRow(
        title = pc.name,
        detail = "${stringResource(stateName(state))} · ${routeLabel(route)}",
        modifier = Modifier.testTag("settings.computer.${pc.id}"),
        onClick = onClick,
        avatar = {
            if (computerIconRes(pc.icon) != null) ComputerIcon(pc.icon, size = 22.dp, tint = p.ink)
            else Icon(Icons.Outlined.Computer, contentDescription = null, tint = p.ink, modifier = Modifier.size(20.dp))
        },
        badge = dot,
    )
}

/** The iPhone's `AvatarBadge` row: a round avatar, a title and one quiet line, opening a page. */
@Composable
internal fun AvatarRow(
    title: String,
    detail: String?,
    modifier: Modifier = Modifier,
    dim: Boolean = false,
    detailColor: Color? = null,
    size: Dp = 40.dp,
    badge: Color? = null,
    onClick: () -> Unit,
    avatar: @Composable () -> Unit,
) {
    val p = Nekko.palette
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box {
            Box(Modifier.size(size).background(p.surface2, CircleShape), contentAlignment = Alignment.Center) { avatar() }
            if (badge != null) {
                Box(Modifier.align(Alignment.BottomEnd).size(10.dp).border(1.5.dp, p.paper, CircleShape).background(badge, CircleShape))
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (dim) p.inkFaint else p.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = detailColor ?: p.inkFaint, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
    }
}

/** "Add a computer", "Add a provider": a plus and the words, in the accent. */
@Composable
internal fun PlusRow(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = p.accent, modifier = Modifier.size(22.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyLarge, color = p.accent)
    }
}

/** A quiet row with an icon that opens a page, lined up with the avatar rows. */
@Composable
private fun QuietLinkRow(title: String, icon: ImageVector, detail: String?, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val p = Nekko.palette
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = p.inkSoft, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkFaint) }
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = p.inkFaint, modifier = Modifier.size(20.dp))
    }
}

/** [computersDetail] in the phone's language. */
@Composable
private fun computersDetailText(c: ComputersState): String {
    val n = c.computers.size
    val active = c.active?.name
    return when {
        n == 0 -> stringResource(R.string.settings_computers_none)
        n == 1 && active != null -> active
        active != null -> stringResource(R.string.settings_computers_paired_using, n, active)
        else -> stringResource(R.string.settings_computers_paired, n)
    }
}

/** The same in English, as the JVM tests read it. */
internal fun computersDetail(c: ComputersState): String {
    val n = c.computers.size
    val active = c.active?.name
    return when {
        n == 0 -> "None paired yet"
        n == 1 && active != null -> active
        active != null -> "$n paired · using $active"
        else -> "$n paired"
    }
}
