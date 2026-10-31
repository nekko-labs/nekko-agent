package com.nekko.android.ui.settings

import androidx.compose.material3.RadioButton
import androidx.compose.foundation.selection.selectable
import com.nekko.protocol.LiveLevel
import com.nekko.android.connection.LiveCards
import androidx.compose.ui.platform.testTag

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
import com.nekko.android.data.OfflineFileStore
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
    val cardLevel by deps.phonePrefs.flow(LiveCards.LEVEL).collectAsStateWithLifecycle()
    val needsYou by deps.phonePrefs.flow(Notices.NEEDS_YOU).collectAsStateWithLifecycle()
    val finished by deps.phonePrefs.flow(Notices.FINISHED).collectAsStateWithLifecycle()
    val failed by deps.phonePrefs.flow(Notices.FAILED).collectAsStateWithLifecycle()
    val notify = needsYou || finished || failed
    var testNote by remember { mutableStateOf<String?>(null) }
    val keepList by deps.phonePrefs.flow(ChatListFiles.ENABLED).collectAsStateWithLifecycle()
    val keepChats by deps.phonePrefs.flow(OfflineFileStore.KEEP_TRANSCRIPTS).collectAsStateWithLifecycle()
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
            if (keep) {
                // The Lock Screen card (the iPhone's Live Activity levels): what that notification shows.
                Text("Lock Screen card", style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.padding(start = 12.dp, top = 8.dp))
                // Stored at the app's first start (LiveCards.firstLevel); Minimal until then.
                val current = cardLevel ?: LiveLevel.MINIMAL
                for ((level, title, detail) in listOf(
                    Triple(LiveLevel.NONE, "Counts only", "How many chats are running, nothing else"),
                    Triple(LiveLevel.MINIMAL, "Minimal", "What the chat that needs you is doing, with Stop and Deny. No chat text"),
                    Triple(LiveLevel.STANDARD, "Standard", "Adds the chat's name, its live step and Allow"),
                    Triple(LiveLevel.DETAILED, "Detailed", "Adds the first line of the latest reply"),
                )) {
                    RadioRow(title, detail, selected = current == level, tag = "settings.card.${level.wire}") { deps.phonePrefs.set(LiveCards.LEVEL, level) }
                }
                Text(
                    when (current) {
                        LiveLevel.NONE, LiveLevel.MINIMAL -> "No chat text leaves your computer for the lock screen."
                        else -> "Chat names and steps show when the phone is unlocked; a locked phone that hides sensitive content shows the Minimal words. Allow asks you to unlock first."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = p.inkSoft,
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                )
            }
            HorizontalDivider(color = p.line)
            // Notify me about (the iPhone's IO-30): one switch per kind, while the app is out of sight.
            Text("Notify me about", style = MaterialTheme.typography.labelMedium, color = p.inkFaint, modifier = Modifier.padding(start = 12.dp, top = 8.dp))
            for ((key, title, detail) in listOf(
                Triple(Notices.NEEDS_YOU, "Approvals and questions", "A tool waits for your Allow, or the agent asks you something"),
                Triple(Notices.FINISHED, "Finished replies", "A reply on your computer is ready"),
                Triple(Notices.FAILED, "Failed replies", "A reply ended with an error"),
            )) {
                val on = when (key) {
                    Notices.NEEDS_YOU -> needsYou
                    Notices.FINISHED -> finished
                    else -> failed
                }
                SwitchRow(
                    title = title,
                    detail = detail,
                    checked = on,
                    onChange = { want ->
                        deps.phonePrefs.set(key, want)
                        if (want && !allowed && Build.VERSION.SDK_INT >= 33) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    },
                )
            }
            TextButton(
                onClick = {
                    val name = deps.repo.state.value.active?.name ?: "your computer"
                    testNote = if (notices?.postTest(name) == true) {
                        "Shown by the app. Until Nekko Agent can push to Android, notifications arrive while the app is open or running in the background."
                    } else {
                        "Notifications are off for Nekko on this phone. Allow them below."
                    }
                },
                modifier = Modifier.padding(start = 4.dp).testTag("settings.testNotification"),
            ) { Text("Send a test notification") }
            testNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp)) }
            HorizontalDivider(color = p.line)
            SwitchRow(
                title = "Keep the chat list when offline",
                detail = "Chat titles and folders as last seen, never what they say. Not backed up; off deletes it",
                checked = keepList,
                onChange = { on ->
                    (context.applicationContext as? NekkoApp)?.setKeepChatList(on) ?: deps.phonePrefs.set(ChatListFiles.ENABLED, on)
                },
            )
            HorizontalDivider(color = p.line)
            SwitchRow(
                title = "Keep recent chats to read offline",
                detail = "The last 20 chats you opened, without their photos. Not backed up; off deletes them",
                checked = keepChats,
                onChange = { on ->
                    (context.applicationContext as? NekkoApp)?.setKeepTranscripts(on) ?: deps.phonePrefs.set(OfflineFileStore.KEEP_TRANSCRIPTS, on)
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
private fun RadioRow(title: String, detail: String, selected: Boolean, tag: String, onSelect: () -> Unit) {
    val p = Nekko.palette
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
            .heightIn(min = 56.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = p.inkSoft)
        }
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
