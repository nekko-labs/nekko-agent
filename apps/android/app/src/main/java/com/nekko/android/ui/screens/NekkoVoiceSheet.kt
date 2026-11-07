package com.nekko.android.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.connection.StatusDashboard
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.voice.AndroidMic
import com.nekko.android.voice.Dictation
import com.nekko.android.voice.DictationController
import com.nekko.android.voice.MicState
import com.nekko.android.voice.NekkoVoice
import com.nekko.android.voice.VoiceGeneration
import com.nekko.protocol.LiveCardState
import com.nekko.protocol.RelayState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow

/** Foreground-only, inside MainActivity's LockGate. Entry never starts the microphone automatically. */
@Composable
fun NekkoVoiceSheet(repo: ComputersRepository, prefs: PhonePrefs, card: StateFlow<LiveCardState?>, openApp: () -> Unit) {
    val context = LocalContext.current
    val appLock = com.nekko.android.lock.LocalAppLock.current
    val locked = appLock?.status?.collectAsStateWithLifecycle()?.value?.locked ?: false
    val covered = appLock?.covered?.collectAsStateWithLifecycle()?.value ?: false
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val initialComputer = remember { repo.state.value.activeId }
    val computerName = remember { repo.state.value.active?.name ?: "your computer" }
    val dispatcher = remember { NekkoVoice() }
    val generation = remember { VoiceGeneration() }
    var message by remember { mutableStateOf("Say status, or send to an exact chat name saying the message. Confirm with the same exact name and message. Approvals and other actions stay in the app.") }
    var busy by remember { mutableStateOf(false) }
    var hasQueued by remember { mutableStateOf(false) }
    val dictation = remember {
        DictationController(scope, repo.caller, AndroidMic(context),
            { prefs.get(Dictation.ENGINE) to prefs.get(Dictation.LANGUAGE) },
            { val s = repo.state.value; DictationController.computerVoice(repo.caller, s.conn == RelayState.ONLINE, s.pcSettings.voiceEnabled) },
            { computerName })
    }
    val mic by dictation.state.collectAsStateWithLifecycle()
    val error by dictation.error.collectAsStateWithLifecycle()
    val state by repo.state.collectAsStateWithLifecycle()
    val totals by card.collectAsStateWithLifecycle()
    fun cancel() {
        generation.cancel()
        dictation.cancel()
        dispatcher.cancel()
        busy = false
        message = if (hasQueued) "Stopped listening. Previously queued messages are not recalled. Open app to review delivery." else "Cancelled. Nothing sent."
    }
    fun authorized(): Boolean = com.nekko.android.voice.VoiceAccess.allowed(
        resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),
        locked = appLock?.status?.value?.locked ?: false,
        covered = appLock?.covered?.value ?: false,
        sameComputer = initialComputer != null && repo.state.value.activeId == initialComputer,
        denied = repo.state.value.denied != null)
    LaunchedEffect(locked, covered) { if (locked || covered) cancel() }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) cancel()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); cancel() }
    }
    LaunchedEffect(state.activeId) {
        if (state.activeId != initialComputer) {
            cancel()
            message = "Computer changed. Nothing sent. Open app and start again."
        }
    }
    // Bound the entire capture, including startup and transcription. Never restart after timeout.
    LaunchedEffect(busy) {
        if (busy) {
            delay(60_000)
            cancel()
            message = "Voice timed out. Nothing sent. Tap Listen to try again."
        }
    }
    LaunchedEffect(error) {
        if (error != null) {
            generation.cancel()
            dispatcher.cancel()
            busy = false
            message = "Voice capture unavailable. Nothing sent. Check microphone permission and Dictation settings in the app."
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // A permission dialog can pause the activity. A fresh explicit tap is required afterwards.
        cancel()
        message = if (granted) "Microphone allowed. Tap Listen when ready." else "Microphone denied. Nothing sent. Enable it in Android app permissions to use voice."
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Talk to Nekko", style = MaterialTheme.typography.headlineSmall)
        Text("On $computerName")
        Text("Android voice opens this foreground sheet. Unlock first, then tap Listen. Audio uses your existing Dictation engine and language settings; phone recognition may use its provider's network service. No background listening.")
        totals?.let {
            if (state.conn != RelayState.ONLINE || state.savedListAt != null) Text("Offline or stale. Last known totals.")
            Text(StatusDashboard.summary(it))
            Text(StatusDashboard.detail(it))
        }
        Text(when (mic) {
            is MicState.Recording -> "Listening…"
            is MicState.Transcribing -> "Processing…"
            MicState.Idle -> if (busy) "Preparing microphone…" else message
        })
        Button(modifier = Modifier.fillMaxWidth(), enabled = state.activeId == initialComputer && initialComputer != null && (mic !is MicState.Transcribing), onClick = {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                permission.launch(Manifest.permission.RECORD_AUDIO)
            } else if (mic is MicState.Recording) {
                dictation.toggle { }
            } else if (!busy && authorized()) {
                val token = generation.begin()
                busy = true
                dictation.toggle { words ->
                    if (generation.accepts(token) && authorized()) {
                        busy = false
                        val s = repo.state.value
                        val c = card.value
                        if (s.activeId != initialComputer || initialComputer == null) {
                            dispatcher.cancel()
                            message = "Computer changed. Nothing sent."
                        } else if (words.trim().lowercase() in listOf("status", "agent status", "what is happening", "what is happening?") && c == null) {
                            message = "Status unavailable. Open app to review agents."
                        } else {
                            val result = dispatcher.dispatch(words, NekkoVoice.Context(initialComputer, computerName,
                                s.conn == RelayState.ONLINE && s.savedListAt == null, s.ready && !s.summariesLoading && s.denied == null,
                                c ?: LiveCardState(emptyList(), null),
                                s.summaries.filter { !it.archived }.map { NekkoVoice.Target(it.id, it.title) }))
                            message = when (result) {
                                is NekkoVoice.Result.Message -> result.text
                                is NekkoVoice.Result.Send -> {
                                    // Synchronous scope check and enqueue on main; no suspension can switch computers between them.
                                    if (repo.state.value.activeId != result.computerId || repo.state.value.denied != null) "Not sent. Computer unavailable. Open app."
                                    else {
                                        repo.outbox.add(chatId = result.sessionId, text = result.text)
                                        repo.outbox.flushSoon()
                                        hasQueued = true
                                        "Queued for this computer. Not yet confirmed sent or completed. Open app to check delivery."
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }) {
            Icon(Icons.Default.Mic, contentDescription = null)
            Text(if (mic is MicState.Recording) "Stop listening" else "Listen", Modifier.padding(start = 8.dp))
        }
        if (hasQueued) Text("A message was queued earlier. Cancel only discards current voice input; it does not recall queued work.")
        OutlinedButton(onClick = { cancel() }) { Text("Cancel / discard") }
        TextButton(onClick = { cancel(); openApp() }) { Text("Open app") }
    }
}
