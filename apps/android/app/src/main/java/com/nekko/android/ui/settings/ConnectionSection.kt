package com.nekko.android.ui.settings

import android.Manifest
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.data.ChatListFiles
import com.nekko.android.NekkoApp
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.Notices
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.ui.components.NCard
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.SectionHeader
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko

/**
 * Settings → Connection: stay connected while a chat runs, notify when it
 * finishes or needs you, and a warning when Android restricts the app in the
 * background. Reconnecting on a network change is always on and has no switch.
 */
@Composable
fun ConnectionSection(deps: SettingsDeps) {
    val p = Nekko.palette
    val context = LocalContext.current
    val lock = LocalAppLock.current
    val keep by deps.phonePrefs.flow(KeepAlive.ENABLED).collectAsStateWithLifecycle()
    val notify by deps.phonePrefs.flow(Notices.ENABLED).collectAsStateWithLifecycle()
    val keepList by deps.phonePrefs.flow(ChatListFiles.ENABLED).collectAsStateWithLifecycle()
    val notices = (context.applicationContext as? NekkoApp)?.connection?.notices
    var allowed by remember { mutableStateOf(notices?.allowed() ?: true) }
    var restricted by remember { mutableStateOf(backgroundRestricted(context)) }
    var asked by remember { mutableStateOf(false) }
    // The user may change either in system settings and come back.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        allowed = notices?.allowed() ?: true
        restricted = backgroundRestricted(context)
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        asked = true
        allowed = notices?.allowed() ?: it
    }
    val openSystem: (Intent) -> Unit = { intent ->
        lock?.expectReturn()
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            context.startActivity(appDetails(context))
        }
    }

    SectionHeader("Connection")
    Column(Modifier.padding(horizontal = 16.dp)) {
        NCard {
            SwitchRow(
                title = "Stay connected while a chat runs",
                detail = "Keeps a notification up until the reply is done",
                checked = keep,
                onChange = { deps.phonePrefs.set(KeepAlive.ENABLED, it) },
            )
            HorizontalDivider(color = p.line)
            SwitchRow(
                title = "Notify me",
                detail = "When a reply finishes or a chat needs your answer",
                checked = notify,
                onChange = { want ->
                    deps.phonePrefs.set(Notices.ENABLED, want)
                    if (want && !allowed && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                },
            )
            HorizontalDivider(color = p.line)
            SwitchRow(
                title = "Keep the chat list when offline",
                detail = "Chat titles and folders as last seen, never what they say. Not backed up; off deletes it",
                checked = keepList,
                onChange = { on ->
                    (context.applicationContext as? NekkoApp)?.setKeepChatList(on) ?: deps.phonePrefs.set(ChatListFiles.ENABLED, on)
                },
            )
        }
        if (notify && !allowed) {
            Notice(
                "Notifications are off for Nekko, so you won’t hear when a chat finishes or needs you.",
                Tone.WARNING,
                Modifier.padding(top = 10.dp),
            )
            TextButton(onClick = {
                // Android asks once or twice; after that only the system screen can turn them on.
                if (Build.VERSION.SDK_INT >= 33 && !asked) {
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    openSystem(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                }
            }) { Text("Allow notifications") }
        }
        if (restricted) {
            Notice(
                "Android restricts Nekko in the background, so it disconnects soon after you leave the app. Allow background use in the app’s battery settings.",
                Tone.WARNING,
                Modifier.padding(top = 10.dp),
            )
            TextButton(onClick = { openSystem(appDetails(context)) }) { Text("Open app settings") }
        }
        Text(
            "Saved on this phone. Nekko reconnects by itself when your phone changes network. Notifications say only what happened and in which chat, never the reply or the command; with the app lock on they don’t name the chat either.",
            style = MaterialTheme.typography.bodySmall,
            color = p.inkFaint,
            modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Switch, onValueChange = onChange)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkFaint)
        }
        // The row handles the toggle, so the switch itself is not a second target.
        Switch(checked = checked, onCheckedChange = null)
    }
}

/** "Restricted" in the app's battery settings (API 28+): Android stops background work entirely. */
private fun backgroundRestricted(context: Context): Boolean =
    context.getSystemService(ActivityManager::class.java)?.isBackgroundRestricted == true

/**
 * The app's own page in system settings, where Battery → Unrestricted / Optimized lives.
 * Deliberately not ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: Play allows that permission
 * only for a few app categories, and the keep-alive service does not need it.
 */
private fun appDetails(context: Context) =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
