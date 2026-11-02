package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.theme.Nekko

/** Settings → On <computer>: its providers (AN-36), its files (AN-33) and logs (AN-34), its automations (Run now) and its providers' usage and limits (AN-29). */
@Composable
fun AutomationsUsageSection(deps: SettingsDeps) {
    val c by deps.repo.state.collectAsStateWithLifecycle()
    if (c.active == null) return
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.settings_providers),
                detail = c.providers.takeIf { it.isNotEmpty() }?.let { list -> stringResource(R.string.settings_providers_count, list.count { it.enabled }, list.size) }
                    ?: stringResource(R.string.settings_providers_none),
                icon = Icons.Filled.Key,
                onClick = { deps.open(Routes.PROVIDERS) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = stringResource(R.string.settings_files),
                detail = stringResource(R.string.settings_files_detail),
                icon = Icons.Filled.FolderOpen,
                onClick = { deps.open(Routes.FILES) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = stringResource(R.string.settings_logs),
                detail = stringResource(R.string.settings_logs_detail),
                icon = Icons.AutoMirrored.Filled.ReceiptLong,
                onClick = { deps.open(Routes.LOGS) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = stringResource(R.string.settings_automations),
                detail = if (c.pcSettings.automationsPaused) stringResource(R.string.settings_automations_paused) else stringResource(R.string.settings_automations_detail),
                icon = Icons.Filled.Schedule,
                onClick = { deps.open(Routes.AUTOMATIONS) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = stringResource(R.string.settings_usage),
                detail = stringResource(R.string.settings_usage_detail),
                icon = Icons.Filled.DataUsage,
                onClick = { deps.open(Routes.USAGE) },
            )
        }
    }
}
