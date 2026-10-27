package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DataUsage
import androidx.compose.material.icons.filled.FolderOpen
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

/** Settings → On <computer>: its files (AN-33), its automations (Run now) and its providers' usage and limits (AN-29). */
@Composable
fun AutomationsUsageSection(deps: SettingsDeps) {
    val c by deps.repo.state.collectAsStateWithLifecycle()
    if (c.active == null) return
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        NCard {
            SettingsRow(
                title = "Files",
                detail = "Saved folders, browse and edit small text files",
                icon = Icons.Filled.FolderOpen,
                onClick = { deps.open(Routes.FILES) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = "Automations",
                detail = if (c.pcSettings.automationsPaused) "Paused · Run now still works" else "Tasks and workflows, Run now",
                icon = Icons.Filled.Schedule,
                onClick = { deps.open(Routes.AUTOMATIONS) },
            )
            HorizontalDivider(color = Nekko.palette.line)
            SettingsRow(
                title = "Usage and limits",
                detail = "What the providers used, and each plan's limits",
                icon = Icons.Filled.DataUsage,
                onClick = { deps.open(Routes.USAGE) },
            )
        }
    }
}
