package com.nekko.android.lock

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.withResumed
import com.nekko.android.ui.components.Notice
import com.nekko.android.ui.components.Tone
import com.nekko.android.ui.theme.Nekko

/** The activity's [Authenticator], for screens that must re-check the user (turning the lock off). */
val LocalAuthenticator = staticCompositionLocalOf<Authenticator?> { null }

/** The app lock, for screens that send the user out of the app and back (QR scanner, system settings). */
val LocalAppLock = staticCompositionLocalOf<AppLock?> { null }

/**
 * Draws [content] and, while [lock] is locked, covers it with the lock screen.
 *
 * The app stays composed underneath so a chat, a draft or a half-filled form is
 * where the user left it after unlocking. While locked the content is hidden
 * from accessibility services, gets no touches, and loses keyboard focus.
 * Deep links are still routed underneath and appear once unlocked.
 *
 * With the lock on, the plain [PrivacyCover] also hides the content while the
 * activity is paused (see [AppLock.covered]), for the recent-apps overview.
 */
@Composable
fun LockGate(lock: AppLock, authenticator: Authenticator, content: @Composable () -> Unit) {
    val status by lock.status.collectAsStateWithLifecycle()
    // Not collectAsStateWithLifecycle: the cover must be drawn while the activity is paused.
    val covered by lock.covered.collectAsState()
    val hidden = status.locked || covered
    val focus = LocalFocusManager.current
    LaunchedEffect(status.locked) { if (status.locked) focus.clearFocus(force = true) }

    Box(Modifier.fillMaxSize()) {
        Box(if (hidden) Modifier.fillMaxSize().clearAndSetSemantics { } else Modifier.fillMaxSize()) {
            content()
        }
        if (status.locked) {
            LockScreen(status.epoch, lock, authenticator)
        } else if (covered) {
            PrivacyCover()
        }
    }
}

/**
 * What the recent-apps overview shows while the lock is on: the app's colours
 * and its lock mark, no content. Drawn only while the activity is not in front,
 * so screenshots taken in the app are never affected.
 */
@Composable
private fun PrivacyCover() {
    val p = Nekko.palette
    Box(
        Modifier.fillMaxSize().background(p.paper).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)).background(p.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Lock, contentDescription = null, tint = p.accent, modifier = Modifier.size(36.dp))
        }
    }
}

@Composable
private fun LockScreen(epoch: Int, lock: AppLock, authenticator: Authenticator) {
    val p = Nekko.palette
    var error by remember { mutableStateOf<String?>(null) }
    // The prompt opens by itself once per lock; after a cancel the button reopens it.
    var prompted by rememberSaveable { mutableStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    val title = stringResource(R.string.settings_unlock_title)
    val subtitle = stringResource(R.string.settings_unlock_subtitle)
    val unlock = {
        error = null
        authenticator.authenticate(title = title, subtitle = subtitle) { r ->
            when (r) {
                AuthResult.Success -> lock.unlock()
                AuthResult.Cancelled -> Unit
                is AuthResult.Failed -> error = r.message
            }
        }
    }

    LaunchedEffect(epoch) {
        // A phone without a screen lock has nothing to check against; the setting explains it.
        if (!authenticator.deviceSecure()) { lock.unlock(); return@LaunchedEffect }
        if (prompted == epoch) return@LaunchedEffect
        // The prompt is a fragment: only show it on a resumed activity.
        lifecycle.withResumed { prompted = epoch; unlock() }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(p.paper)
            .pointerInput(Unit) { awaitEachGesture { awaitFirstDown(requireUnconsumed = false).consume() } }
            .safeDrawingPadding()
            .padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(72.dp).clip(RoundedCornerShape(20.dp)).background(p.accentSoft),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Lock, contentDescription = null, tint = p.accent, modifier = Modifier.size(36.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.settings_locked), style = MaterialTheme.typography.headlineSmall, color = p.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(8.dp))
        Text(
            stringResource(R.string.settings_locked_detail),
            style = MaterialTheme.typography.bodyLarge,
            color = p.inkSoft,
            textAlign = TextAlign.Center,
        )
        error?.let {
            Spacer(Modifier.height(16.dp))
            Notice(it, Tone.DANGER)
        }
        Spacer(Modifier.height(24.dp))
        Button(onClick = unlock, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Icon(Icons.Filled.Fingerprint, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.settings_unlock))
        }
    }
}
