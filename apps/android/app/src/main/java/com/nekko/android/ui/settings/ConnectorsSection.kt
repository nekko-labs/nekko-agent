package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard

/** Settings → Connectors (#2109): this phone's own git providers and project tools. */
@Composable
fun ConnectorsSection(deps: SettingsDeps) {
    val connectors = (LocalContext.current.applicationContext as? com.nekko.android.NekkoApp)?.connectors ?: return
    val s by connectors.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { connectors.load() }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.connectors_title),
                detail = s.connectors.takeIf { it.isNotEmpty() }?.joinToString(", ") { it.label } ?: stringResource(R.string.connectors_row_detail),
                icon = Icons.Outlined.Hub,
                onClick = { deps.open(Routes.CONNECTORS) },
            )
        }
    }
}
