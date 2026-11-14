package com.nekko.android.permissions

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Error
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.ScreenLockPortrait
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.R
import com.nekko.android.data.PhonePrefs
import com.nekko.android.lock.AuthResult
import com.nekko.android.lock.LocalAuthenticator
import com.nekko.android.ui.components.PixelCat
import com.nekko.android.ui.theme.Nekko

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/**
 * The permissions checklist (the iPhone's PermissionChecklistView): one row per thing the phone
 * can do for Nekko, Recommended then Optional, one open at a time. Each reads the system's real
 * answer when the page shows, after every request and whenever the app comes back to the front;
 * nothing is asked on its own. Nothing here is required: [onDone] (onboarding's Continue) is
 * always there.
 */
@Composable
fun PermissionChecklist(prefs: PhonePrefs, modifier: Modifier = Modifier, step: (@Composable () -> Unit)? = null, onDone: ((allSettled: Boolean) -> Unit)? = null) {
    val p = Nekko.palette
    val context = LocalContext.current
    val activity = remember(context) { context.activity() }
    val auth = LocalAuthenticator.current
    val res = androidx.compose.ui.platform.LocalResources.current
    val asked by prefs.flow(PermissionStates.ASKED).collectAsStateWithLifecycle()
    var refresh by remember { mutableIntStateOf(0) }
    var verified by remember { mutableStateOf(false) }
    val skipped = remember { mutableStateMapOf<PermissionItem, Boolean>() }
    var busy by remember { mutableStateOf<PermissionItem?>(null) }
    var note by remember { mutableStateOf<Pair<PermissionItem, String>?>(null) }
    val states = remember(asked, refresh, verified) {
        PermissionItem.entries.associateWith { item ->
            PermissionStates.read(context, item, asked, { perm -> activity?.let { ActivityCompat.shouldShowRequestPermissionRationale(it, perm) } == true }, verified)
        }
    }
    // The first row still to settle opens by itself; the person can open any other.
    fun settled(i: PermissionItem) = states.getValue(i).let { it.checked || it == PermissionState.DENIED || !it.requestable || (i == PermissionItem.SPEECH) } || skipped[i] == true
    var open by remember { mutableStateOf(PermissionItem.entries.firstOrNull { !settled(it) }) }
    val next = { open = PermissionItem.entries.firstOrNull { !settled(it) } }

    // Back from the system's settings, or any return to the app: read everything again.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) refresh++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val item = busy
        busy = null
        refresh++
        // Only a real yes moves on; a no keeps the row open, saying what changed.
        if (granted) next() else if (item != null) open = item
    }
    val allSettled = PermissionItem.entries.all { settled(it) }
    val done = PermissionItem.entries.count { states.getValue(it).checked || (it == PermissionItem.SPEECH && states.getValue(it) == PermissionState.AVAILABLE) }

    Column(modifier.fillMaxSize()) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).testTag("permissions.list"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 680.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                step?.invoke()
                PixelCat(Modifier.size(56.dp))
                Text(
                    stringResource(if (allSettled) R.string.permissions_all_set else R.string.permissions_title),
                    style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = p.ink,
                )
                Text(stringResource(if (allSettled) R.string.permissions_subtitle_done else R.string.permissions_subtitle), style = MaterialTheme.typography.bodyLarge, color = p.inkSoft)
                val total = PermissionItem.entries.size
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    LinearProgressIndicator(progress = { done / total.toFloat() }, modifier = Modifier.weight(1f), color = p.accent, trackColor = p.surface2)
                    Text(stringResource(R.string.permissions_progress, done, total), style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.testTag("permissions.progress"))
                }
                for ((title, recommended) in listOf(R.string.permissions_recommended to true, R.string.permissions_optional to false)) {
                    Text(stringResource(title).uppercase(), style = MaterialTheme.typography.labelMedium, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
                    Column(Modifier.fillMaxWidth().background(p.surface, RoundedCornerShape(18.dp)).border(1.dp, p.line, RoundedCornerShape(18.dp))) {
                        val items = PermissionItem.entries.filter { it.recommended == recommended }
                        items.forEachIndexed { i, item ->
                            if (i > 0) HorizontalDivider(color = p.line, modifier = Modifier.padding(start = 52.dp))
                            PermissionRow(
                                item = item,
                                state = states.getValue(item),
                                open = open == item,
                                skipped = skipped[item] == true,
                                busy = busy,
                                note = note?.takeIf { it.first == item }?.second,
                                hasSettings = PermissionStates.settings(context, item) != null,
                                onOpen = { open = if (open == item) null else item },
                                onAction = { action ->
                                    note = null
                                    when (action) {
                                        PermissionAction.ALLOW -> item.permission?.let { perm ->
                                            prefs.set(PermissionStates.ASKED, prefs.get(PermissionStates.ASKED) + perm)
                                            busy = item
                                            ask.launch(perm)
                                        }
                                        PermissionAction.SETTINGS -> PermissionStates.settings(context, item)?.let { intent ->
                                            runCatching { context.startActivity(intent) }.onFailure { context.startActivity(PermissionStates.appSettings(context)) }
                                        }
                                        PermissionAction.TRY -> if (auth != null) {
                                            busy = item
                                            auth.authenticate(res.getString(R.string.permissions_screen_lock_try_title)) { result ->
                                                busy = null
                                                if (result == AuthResult.Success) { verified = true; next() }
                                                else note = item to res.getString(R.string.permissions_not_completed)
                                            }
                                        }
                                        PermissionAction.NONE -> Unit
                                    }
                                },
                                onSkip = { skipped[item] = true; next() },
                            )
                        }
                    }
                }
                Text(stringResource(R.string.permissions_footer), style = MaterialTheme.typography.bodySmall, color = p.inkSoft, modifier = Modifier.padding(top = 8.dp))
                TextButton(onClick = { context.startActivity(PermissionStates.appSettings(context)) }, modifier = Modifier.testTag("permissions.openSettings")) {
                    Text(stringResource(R.string.permissions_open_settings))
                }
                Spacer(Modifier.size(16.dp))
            }
        }
        // Onboarding: always a way on, whatever was allowed.
        if (onDone != null) {
            Button(
                onClick = { onDone(allSettled) },
                modifier = Modifier.fillMaxWidth().padding(16.dp).heightIn(min = 48.dp).testTag("permissions.continue"),
                colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.accentInk),
            ) { Text(stringResource(if (allSettled) R.string.permissions_done else R.string.chats_continue)) }
        }
    }
}

@Composable
private fun PermissionRow(
    item: PermissionItem,
    state: PermissionState,
    open: Boolean,
    skipped: Boolean,
    busy: PermissionItem?,
    note: String?,
    hasSettings: Boolean,
    onOpen: () -> Unit,
    onAction: (PermissionAction) -> Unit,
    onSkip: () -> Unit,
) {
    val p = Nekko.palette
    val title = stringResource(titleOf(item))
    val word = stringResource(if (skipped && !state.checked) R.string.permissions_skipped else stateWord(state))
    // Shape and words, never colour alone.
    val glyph: Pair<ImageVector, androidx.compose.ui.graphics.Color> = when {
        state.checked -> Icons.Outlined.CheckCircle to p.success
        state == PermissionState.DENIED -> Icons.Outlined.Error to p.warning
        !state.requestable || skipped -> Icons.Outlined.RemoveCircleOutline to p.inkFaint
        open -> iconOf(item) to p.accent
        else -> Icons.Outlined.Circle to p.inkFaint
    }
    val showWord = state.checked || state == PermissionState.DENIED || !state.requestable || skipped || state == PermissionState.AVAILABLE
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (open) p.surface2.copy(alpha = 0.6f) else androidx.compose.ui.graphics.Color.Transparent)
            .testTag("perm.${item.name.lowercase()}"),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onOpen)
                .heightIn(min = 56.dp)
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .semantics(mergeDescendants = true) { stateDescription = word },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Icon(glyph.first, contentDescription = null, tint = glyph.second, modifier = Modifier.size(24.dp))
            Text(title, style = MaterialTheme.typography.bodyLarge, color = p.ink, modifier = Modifier.weight(1f))
            if (showWord) Text(word, style = MaterialTheme.typography.bodySmall, color = if (state == PermissionState.DENIED) p.warning else p.inkSoft, modifier = Modifier.testTag("perm.${item.name.lowercase()}.state"))
        }
        if (open) {
            Column(Modifier.padding(start = 52.dp, end = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(detailOf(item)), style = MaterialTheme.typography.bodyMedium, color = p.inkSoft)
                note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = p.warning) }
                val action = PermissionActions.of(item, state, hasSettings)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    when {
                        busy == item -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CircularProgressIndicator(strokeWidth = 2.dp, color = p.accent, modifier = Modifier.size(18.dp))
                            Text(stringResource(R.string.permissions_checking), color = p.inkSoft)
                        }
                        action != PermissionAction.NONE -> Button(
                            onClick = { onAction(action) },
                            enabled = busy == null,
                            colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.accentInk),
                            modifier = Modifier.heightIn(min = 48.dp).testTag("perm.${item.name.lowercase()}.action"),
                        ) {
                            Text(stringResource(when (action) {
                                PermissionAction.ALLOW -> R.string.permissions_allow
                                PermissionAction.TRY -> R.string.permissions_try
                                else -> R.string.permissions_settings
                            }))
                        }
                    }
                    if (!state.checked && state.requestable && state != PermissionState.DENIED && !skipped && busy != item) {
                        OutlinedButton(onClick = onSkip, enabled = busy == null, modifier = Modifier.heightIn(min = 48.dp).testTag("perm.${item.name.lowercase()}.skip")) {
                            Text(stringResource(R.string.chats_not_now), color = p.inkSoft)
                        }
                    }
                }
            }
        }
    }
}

private fun titleOf(i: PermissionItem) = when (i) {
    PermissionItem.ALERTS -> R.string.permissions_alerts
    PermissionItem.BACKGROUND -> R.string.permissions_background
    PermissionItem.LIVE_UPDATES -> R.string.permissions_live_updates
    PermissionItem.MICROPHONE -> R.string.permissions_microphone
    PermissionItem.SPEECH -> R.string.permissions_speech
    PermissionItem.SCREEN_LOCK -> R.string.permissions_screen_lock
    PermissionItem.SAVE_PHOTOS -> R.string.chat_save_to_photos
}

private fun detailOf(i: PermissionItem) = when (i) {
    PermissionItem.ALERTS -> R.string.permissions_alerts_detail
    PermissionItem.BACKGROUND -> R.string.permissions_background_detail
    PermissionItem.LIVE_UPDATES -> R.string.permissions_live_updates_detail
    PermissionItem.MICROPHONE -> R.string.permissions_microphone_detail
    PermissionItem.SPEECH -> R.string.permissions_speech_detail
    PermissionItem.SCREEN_LOCK -> R.string.permissions_screen_lock_detail
    PermissionItem.SAVE_PHOTOS -> R.string.permissions_save_photos_detail
}

private fun iconOf(i: PermissionItem): ImageVector = when (i) {
    PermissionItem.ALERTS -> Icons.Outlined.NotificationsActive
    PermissionItem.BACKGROUND -> Icons.Outlined.BatteryChargingFull
    PermissionItem.LIVE_UPDATES -> Icons.Outlined.ScreenLockPortrait
    PermissionItem.MICROPHONE -> Icons.Outlined.Mic
    PermissionItem.SPEECH -> Icons.Outlined.GraphicEq
    PermissionItem.SCREEN_LOCK -> Icons.Outlined.Fingerprint
    PermissionItem.SAVE_PHOTOS -> Icons.Outlined.AddPhotoAlternate
}

private fun stateWord(s: PermissionState) = when (s) {
    PermissionState.NOT_SET -> R.string.permissions_state_not_set
    PermissionState.ALLOWED -> R.string.permissions_state_allowed
    PermissionState.DENIED -> R.string.permissions_state_denied
    PermissionState.RESTRICTED -> R.string.permissions_state_restricted
    PermissionState.UNAVAILABLE -> R.string.permissions_state_unavailable
    PermissionState.AVAILABLE -> R.string.permissions_state_available
}
