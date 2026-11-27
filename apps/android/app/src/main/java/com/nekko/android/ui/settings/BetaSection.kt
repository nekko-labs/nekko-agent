package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.phone.PhoneCloudBeta
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.theme.Nekko

/**
 * Settings → Beta: cloud models on this phone ([PhoneCloudBeta], the iPhone's Beta section).
 * Off for a new install; on brings back This phone in Chats and Run on, and Models on This phone.
 */
@Composable
fun BetaSection(deps: SettingsDeps) {
    val phone = deps.phone ?: return
    val s by phone.state.collectAsStateWithLifecycle()
    val p = Nekko.palette
    SectionHeader(stringResource(R.string.settings_beta))
    Column(Modifier.padding(horizontal = 16.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .toggleable(value = s.available, role = Role.Switch) { PhoneCloudBeta.set(deps.phonePrefs, phone, it) }
                .heightIn(min = 56.dp)
                .padding(vertical = 8.dp)
                .testTag("settings.phoneCloudBeta"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.settings_phone_cloud_beta, stringResource(R.string.chats_this_phone)),
                style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f),
            )
            // The row handles the toggle, so the switch itself is not a second target.
            Switch(checked = s.available, onCheckedChange = null)
        }
        Text(stringResource(R.string.settings_phone_cloud_beta_detail), style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
    }
}
