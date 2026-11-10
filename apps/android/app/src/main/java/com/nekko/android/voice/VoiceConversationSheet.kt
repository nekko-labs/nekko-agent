package com.nekko.android.voice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner

/** Parent supplies translated labels without changing existing resources in this implementation layer. */
data class VoiceLabels(
    val title: String = "Voice conversation",
    val explanation: String = "Tap Start, then speak. Each spoken turn is sent to this chat. The phone reads the reply, then listens again. Leaving or locking stops voice, not the agent's work.",
    val start: String = "Start",
    val stop: String = "Stop",
    val close: String = "Close",
    val settings: String = "Open microphone settings",
    val permissionGranted: String = "Microphone allowed. Tap Start to begin.",
    val permissionDenied: String = "Allow microphone access in Settings → Apps → Nekko Agent → Permissions.",
    val unavailable: String = "This phone needs installed on-device speech recognition (Android 12 or later). No cloud speech fallback is used.",
    val ready: String = "Ready",
    val listening: String = "Listening",
    val waiting: String = "Thinking",
    val speaking: String = "Speaking",
    val stopped: String = "Stopped",
    val heard: String = "You said",
    val reply: String = "Reply",
)

/**
 * New surface, no automatic Start on opening or permission grant. Key by stable chat + computer id.
 * [authorized] must become false on app lock/cover, disconnect, input-blocked chat or target change.
 * [isAuthorized] must read live lock/cover/target/connection state, not a captured Compose Boolean.
 * The parent must refuse Start over an existing run; its own voice-created run must remain authorized.
 * [respond] must return ONLY the new completed assistant reply, not a cached/streaming reply.
 */
@Composable
fun VoiceConversationSheet(
    targetKey: String,
    authorized: Boolean,
    isAuthorized: () -> Boolean,
    respond: suspend (String) -> String,
    onDismiss: () -> Unit,
    language: String = "",
    labels: VoiceLabels = VoiceLabels(),
    audioToken: Any? = null,
    beforeStart: () -> Unit = {},
    isStartAuthorized: () -> Boolean = isAuthorized,
    onAudioRevoked: () -> Unit = {},
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val conversation = remember(targetKey, owner) { VoiceConversation(scope) }
    val lease = remember(targetKey, owner, audioToken) { audioToken ?: Any() }
    // Read live lock/target/connection state at the I/O boundary, not last frame's Compose Boolean.
    val allowed by rememberUpdatedState(isAuthorized)
    val state by conversation.state.collectAsState()
    var permissionNotice by remember(targetKey) { mutableStateOf<String?>(null) }
    val audio = remember(targetKey, owner) { ConversationAudio(context) { conversation.stop() } }
    val safety = remember(targetKey, owner) { VoiceSafety(context, owner) { conversation.stop() } }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // Permission completion has no authority to start audio, even after background, lock or target change.
        permissionNotice = if (granted) labels.permissionGranted else labels.permissionDenied
    }
    DisposableEffect(conversation, audio, safety, lease) {
        safety.start()
        onDispose { VoiceAudioOwner.release(lease); conversation.stop(); safety.close(); audio.close() }
    }
    LaunchedEffect(authorized) { conversation.safetyChanged(authorized) }
    // Dialogs have their own window: a LockGate overlay in the activity cannot safely cover one.
    if (!authorized) return
    fun dismiss() { conversation.stop(); onDismiss() }
    AlertDialog(
        onDismissRequest = { dismiss() },
        modifier = Modifier.widthIn(max = 560.dp),
        title = { Text(labels.title) },
        text = {
            Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(labels.explanation)
                Text(when (state.phase) {
                    VoiceConversation.Phase.READY -> labels.ready
                    VoiceConversation.Phase.LISTENING -> labels.listening
                    VoiceConversation.Phase.WAITING -> labels.waiting
                    VoiceConversation.Phase.SPEAKING -> labels.speaking
                    VoiceConversation.Phase.STOPPED -> labels.stopped
                }, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleMedium)
                if (state.heard.isNotEmpty()) Text("${labels.heard}: ${state.heard}")
                if (state.reply.isNotEmpty()) Text("${labels.reply}: ${state.reply}")
                (state.error ?: permissionNotice)?.let {
                    Text(it, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error)
                }
                TextButton(onClick = {
                    conversation.stop()
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
                }) { Text(labels.settings) }
            }
        },
        confirmButton = {
            if (state.active) Button(onClick = { conversation.stop() }) { Text(labels.stop) }
            else Button(enabled = authorized, onClick = {
                permissionNotice = null
                if (isStartAuthorized() && safety.foreground) {
                    if (!audio.available()) permissionNotice = labels.unavailable
                    else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.RECORD_AUDIO)
                    else try {
                        beforeStart()
                        VoiceAudioOwner.claim(lease) { conversation.stop(); onAudioRevoked() }
                        conversation.start(VoiceConversation.IO(
                            capture = { audio.capture(language) },
                            // Bound to the original target, never re-resolved after suspension.
                            respond = respond,
                            speak = { audio.speak(it, language) },
                            stopAudio = { audio.stop() },
                            allowed = { allowed() && safety.foreground && VoiceAudioOwner.owns(lease) },
                        ))
                    } catch (e: Exception) {
                        VoiceAudioOwner.release(lease)
                        permissionNotice = e.message
                    }
                }
            }) { Text(labels.start) }
        },
        dismissButton = { TextButton(onClick = { dismiss() }) { Text(labels.close) } },
    )
}
