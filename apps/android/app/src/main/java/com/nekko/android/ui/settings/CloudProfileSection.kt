package com.nekko.android.ui.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.Routes
import com.nekko.android.ui.cloud.CloudProfileRow

/** Settings' first row: your Nekko Cloud account, as the Apple Account sits atop iOS Settings (#2940). */
@Composable
fun CloudProfileSection(deps: SettingsDeps) {
    val cloud = deps.cloud ?: return
    Box(Modifier.padding(horizontal = 4.dp, vertical = 8.dp)) {
        CloudProfileRow(cloud) { deps.open(Routes.CLOUD) }
    }
}
