package com.nekko.android.ui.settings

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader

/** Settings → Computers: a way into the paired-computers screen (rename, switch, forget, pair). */
@Composable
fun ComputersSection(deps: SettingsDeps) {
    val c by deps.repo.state.collectAsStateWithLifecycle()
    SectionHeader(stringResource(R.string.settings_computers))
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.settings_computers),
                detail = computersDetailText(c),
                icon = Icons.Filled.Computer,
                onClick = { deps.open(Routes.COMPUTERS) },
            )
        }
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
