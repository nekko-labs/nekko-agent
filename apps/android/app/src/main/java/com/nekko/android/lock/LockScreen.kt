package com.nekko.android.lock

import com.nekko.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.key
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
    // The opening (#2120): on a cold launch, and each time the app locks. Unlocked, it builds the
    // cat and zooms straight in; locked, it holds the cat until the unlock, then zooms.
    var opening by remember { mutableStateOf(status.locked || !Splash.launched) }
    LaunchedEffect(status.locked) { if (status.locked) opening = true }

    Box(Modifier.fillMaxSize()) {
        Box(if (hidden) Modifier.fillMaxSize().clearAndSetSemantics { } else Modifier.fillMaxSize()) {
            content()
        }
        if (opening) {
            LockScreen(status.epoch, status.locked, lock, authenticator, onOpened = { if (!lock.locked) { opening = false; Splash.launched = true } })
        } else if (covered) {
            PrivacyCover()
        }
    }
}

/**
 * What the recent-apps overview shows while the lock is on: the brand plum and the
 * finished cat, as the lock screen, no content. Drawn only while the activity is not in
 * front, so screenshots taken in the app are never affected.
 */
@Composable
private fun PrivacyCover() {
    Canvas(Modifier.fillMaxSize().clearAndSetSemantics { }) { with(Splash) { draw(Splash.ZOOM_AT, 40.dp.toPx()) } }
}

/**
 * The lock screen, the iPhone's lock cover (#1836, #1905, #2120): the opening animation on
 * the brand plum, the cat building up in pixels from the first frame; once it is whole (about
 * 0.7 s) the fingerprint, face or screen-lock prompt opens over it. **Unlock** appears under the cat only once that
 * prompt was cancelled or failed. Unlocked, the cat zooms into the app ([onOpened] once done).
 */
@Composable
private fun LockScreen(epoch: Int, locked: Boolean, lock: AppLock, authenticator: Authenticator, onOpened: () -> Unit) {
    var error by remember { mutableStateOf<String?>(null) }
    /** The prompt was cancelled or failed: offer Unlock under the cat. */
    var offer by remember(epoch) { mutableStateOf(false) }
    /** The cat is whole: the prompt opens over the finished cat, not over a plum the build is hidden under. */
    var built by remember(epoch) { mutableStateOf(false) }
    // The prompt opens by itself once per lock; after a cancel the button reopens it.
    var prompted by rememberSaveable { mutableStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val still = com.nekko.android.ui.simple.rememberReduceMotion()

    val title = stringResource(R.string.settings_unlock_title)
    val subtitle = stringResource(R.string.settings_unlock_subtitle)
    val unlock = {
        error = null
        authenticator.authenticate(title = title, subtitle = subtitle) { r ->
            when (r) {
                AuthResult.Success -> lock.unlock()
                AuthResult.Cancelled -> offer = true
                is AuthResult.Failed -> { error = r.message; offer = true }
            }
        }
    }

    LaunchedEffect(epoch, locked, built) {
        // A launch without the lock only plays the opening: nothing to ask.
        if (!locked) return@LaunchedEffect
        // A phone without a screen lock has nothing to check against; the setting explains it.
        if (!authenticator.deviceSecure()) { lock.unlock(); return@LaunchedEffect }
        // The fingerprint sheet (or the PIN screen) would hide the build: ask once the cat is whole.
        if (!built) return@LaunchedEffect
        if (prompted == epoch) { offer = true; return@LaunchedEffect }
        // The prompt is a fragment: only show it on a resumed activity.
        lifecycle.withResumed { prompted = epoch; unlock() }
    }

    val lockedWords = stringResource(R.string.settings_locked) + ". " + stringResource(R.string.settings_locked_detail)
    Box(
        Modifier
            .fillMaxSize()
            .then(
                if (locked) Modifier
                    .pointerInput(Unit) { awaitEachGesture { awaitFirstDown(requireUnconsumed = false).consume() } }
                    .semantics { contentDescription = lockedWords }
                    .testTag("lock.screen")
                else Modifier.clearAndSetSemantics { },
            ),
        contentAlignment = Alignment.Center,
    ) {
        // A fresh build each time the app locks.
        key(epoch) { PixelOpening(ready = !locked, still = still, onDone = onOpened, onBuilt = { built = true }) }
        if (locked && offer) Column(
            Modifier.safeDrawingPadding().padding(top = 240.dp).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            error?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = PLUM_LIGHT, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
            }
            Button(
                onClick = unlock,
                colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Splash.GROUND),
                modifier = Modifier.widthIn(min = 200.dp).height(48.dp).testTag("lock.unlock"),
            ) {
                Icon(Icons.Filled.Fingerprint, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text(stringResource(R.string.settings_unlock))
            }
        }
    }
}

/** The brand's light plum, `#C99BB3`: small text on the plum ground. */
private val PLUM_LIGHT = Color(0xFFC99BB3)
