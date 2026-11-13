package com.nekko.android.permissions

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Rule
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nekko.android.R
import com.nekko.android.data.PhonePrefs
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.settings.SettingsRow
import com.nekko.android.ui.theme.Nekko

/** Settings → Device access → Permissions: the same checklist as the first run's step 3, any time. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionsScreen(prefs: PhonePrefs, onBack: () -> Unit) {
    val p = Nekko.palette
    Scaffold(
        containerColor = p.paper,
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.permissions_page)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = p.paper),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.settings_back)) } },
            )
        },
    ) { padding -> PermissionChecklist(prefs, Modifier.padding(padding)) }
}

/** Settings → Device access: one row to the permissions checklist (the iPhone's). */
@Composable
fun DeviceAccessSection(deps: SettingsDeps) {
    SectionHeader(stringResource(R.string.permissions_section))
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        NCard {
            SettingsRow(
                title = stringResource(R.string.permissions_page),
                detail = stringResource(R.string.permissions_row_detail),
                icon = Icons.AutoMirrored.Outlined.Rule,
                onClick = { deps.open(Routes.PERMISSIONS) },
            )
        }
    }
}
