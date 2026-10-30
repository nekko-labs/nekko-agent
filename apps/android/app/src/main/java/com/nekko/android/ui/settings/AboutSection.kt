package com.nekko.android.ui.settings

import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Info
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.material.icons.filled.SyncAlt
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.protocol.PhoneProtocol
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nekko.android.ui.Routes
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.SectionHeader

/**
 * Settings → About: the installed version, the phone protocol on each side (IO-32,
 * with the side to update when they differ) and the open-source licenses. Keep it
 * the last section.
 */
@Composable
fun AboutSection(deps: SettingsDeps) {
    val context = LocalContext.current
    val version = remember(context) { appVersion(context) }
    val c by deps.repo.state.collectAsStateWithLifecycle()
    SectionHeader("About")
    Column(Modifier.padding(horizontal = 16.dp)) {
        c.protocolCheck.message(c.active?.name ?: "your computer")?.let { text ->
            Notice(text, Tone.WARNING, Modifier.padding(bottom = 8.dp))
        }
        NCard {
            SettingsRow(title = "Nekko Agent for Android", detail = version, icon = Icons.Filled.Info)
            SettingsRow(
                title = "Phone protocol",
                detail = c.hostProtocol?.let { "${PhoneProtocol.VERSION} here, $it on the computer" } ?: "${PhoneProtocol.VERSION}",
                icon = Icons.Filled.SyncAlt,
            )
            SettingsRow(
                title = "Open-source licenses",
                detail = "Nekko Agent is MIT licensed; the libraries it uses",
                icon = Icons.Filled.Description,
                onClick = { deps.open(Routes.LICENSES) },
            )
        }
    }
}

/** "Version 0.1.0 (1)", read from the installed package so it is always the real one. */
private fun appVersion(context: Context): String {
    val info = try {
        context.packageManager.getPackageInfo(context.packageName, 0)
    } catch (_: PackageManager.NameNotFoundException) {
        return "Version unknown"
    }
    return "Version ${info.versionName ?: "?"} (${info.longVersionCode})"
}
