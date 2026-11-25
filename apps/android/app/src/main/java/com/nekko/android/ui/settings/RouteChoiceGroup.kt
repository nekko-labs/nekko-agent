package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko
import com.nekko.protocol.RouteChoice

/**
 * "Connect through" (#3346): which kinds of route this phone dials to reach one computer, Tailscale
 * and/or Nekko Cloud Relay (both on is `auto`). The last one on can't be turned off, and a kind the
 * pairing link did not carry is off, with one quiet line on how to add it.
 */
@Composable
fun RouteChoiceGroup(
    computerName: String,
    /** Every address the pairing carried, before the choice filters them. */
    routes: List<String>,
    choice: RouteChoice,
    onChoice: (RouteChoice) -> Unit,
) {
    val p = Nekko.palette
    val hasTailscale = RouteChoice.carriesTailscale(routes)
    val hasCloud = RouteChoice.carriesCloud(routes)
    val tailscaleOn = hasTailscale && choice.tailscale
    val cloudOn = hasCloud && choice.cloud
    SectionHeader(stringResource(R.string.conn_route_title))
    NCard(Modifier.padding(horizontal = 16.dp)) {
        RouteRow(stringResource(R.string.conn_route_tailscale), tailscaleOn, available = hasTailscale, canToggle = hasTailscale && (!tailscaleOn || cloudOn), tag = "computer.route.tailscale") {
            onChoice(RouteChoice.of(it, cloudOn))
        }
        HorizontalDivider(color = p.line)
        RouteRow(stringResource(R.string.conn_route_cloud), cloudOn, available = hasCloud, canToggle = hasCloud && (!cloudOn || tailscaleOn), tag = "computer.route.cloud") {
            onChoice(RouteChoice.of(tailscaleOn, it))
        }
    }
    Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!hasCloud) Text(stringResource(R.string.conn_route_add_cloud, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.testTag("computer.route.add-cloud"))
        if (!hasTailscale) Text(stringResource(R.string.conn_route_add_tailscale, computerName), style = MaterialTheme.typography.bodySmall, color = p.inkFaint, modifier = Modifier.testTag("computer.route.add-tailscale"))
    }
}

@Composable
private fun RouteRow(label: String, on: Boolean, available: Boolean, canToggle: Boolean, tag: String, onToggle: (Boolean) -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier.fillMaxWidth()
            .toggleable(value = on, enabled = canToggle, role = Role.Checkbox, onValueChange = onToggle)
            .heightIn(min = 56.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (available) p.ink else p.inkFaint, modifier = Modifier.weight(1f))
        // The row is the control; the last one on keeps its normal look and simply stays on.
        Checkbox(checked = on, onCheckedChange = null, enabled = available)
    }
}
