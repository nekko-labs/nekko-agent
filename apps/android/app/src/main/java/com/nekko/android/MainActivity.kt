package com.nekko.android

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.inspector.WindowInspector
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.lock.Authenticator
import com.nekko.android.lock.LocalAppLock
import com.nekko.android.lock.LocalAuthenticator
import com.nekko.android.lock.LockGate
import com.nekko.android.share.SharedText
import com.nekko.android.ui.NekkoNavHost
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.ThemeResolver
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * The only activity. Deep links (pairing QR from the system camera) arrive here too.
 * A FragmentActivity because the system authentication prompt (app lock) is a fragment.
 */
class MainActivity : FragmentActivity() {
    /** The system prompt for the app lock and for confirming Changes (AN-32). */
    private lateinit var authenticator: Authenticator

    /** The latest link opened from outside the app; the nav host consumes it. */
    private val incomingLink = MutableStateFlow<DeepLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity must not replay the link it was first opened with.
        if (savedInstanceState == null) handle(intent)
        val app = application as NekkoApp
        val repo = app.computers
        authenticator = Authenticator(this)
        app.ownerCheck.attach(authenticator)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) { app.appLock.enabled.collect(::privateRecents) }
        }
        setContent {
            val choice by app.themePrefs.choice.collectAsStateWithLifecycle()
            val computer by repo.appearance.collectAsStateWithLifecycle()
            val look = ThemeResolver.resolve(choice, computer, isSystemInDarkTheme())
            // Status and navigation bar icons follow the app's theme, not only the phone's.
            LaunchedEffect(look.dark) {
                val bars = if (look.dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
            }
            NekkoTheme(dark = look.dark, accent = look.accent) {
                CompositionLocalProvider(LocalAuthenticator provides authenticator, LocalAppLock provides app.appLock) {
                    LockGate(app.appLock, authenticator) {
                        NekkoNavHost(
                            repo = repo,
                            themePrefs = app.themePrefs,
                            phonePrefs = app.phonePrefs,
                            shareInbox = app.shareInbox,
                            haptics = app.haptics,
                            incomingLink = incomingLink,
                            onLinkHandled = { incomingLink.value = null },
                        )
                    }
                }
            }
        }
    }

    /**
     * With the lock on, the recent-apps preview must not show chats, but the
     * app itself stays screenshot-able (no FLAG_SECURE: the user wants to
     * screenshot chats). On API 33+ the system is asked not to keep a snapshot;
     * on every API the privacy cover (AppLock.covered, drawn by LockGate)
     * replaces the content whenever the activity is paused or its window loses
     * focus outside the app, so whatever the overview shows, live or snapshot,
     * is the cover and not the chat.
     */
    private fun privateRecents(hide: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(!hide)
    }

    /** API 34+: tells the lock a screenshot was taken, so the screenshot toolbar does not cover the app. */
    private val screenCapture: Any? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Activity.ScreenCaptureCallback { (application as NekkoApp).appLock.onScreenshot() }
        } else null

    override fun onStart() {
        super.onStart()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            registerScreenCaptureCallback(mainExecutor, screenCapture as Activity.ScreenCaptureCallback)
        }
    }

    override fun onStop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            unregisterScreenCaptureCallback(screenCapture as Activity.ScreenCaptureCallback)
        }
        super.onStop()
    }

    override fun onPause() {
        (application as NekkoApp).appLock.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        (application as NekkoApp).appLock.onResume()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        val lock = (application as NekkoApp).appLock
        if (hasFocus) {
            lock.onFocus(true)
            return
        }
        // Our own dialogs and popups take focus too; only cover when it went
        // outside the app. Checked after the focus has moved to its new window.
        window.decorView.post {
            if (window.decorView.hasWindowFocus() || focusStayedInApp()) return@post
            lock.onFocus(false)
            // A popup (the composer's + menu) can get focus a frame or two after
            // the activity loses it: look again and lift the cover if it did.
            // Covering first keeps the recent-apps overview private meanwhile.
            for (delay in FOCUS_RECHECK_MS) {
                window.decorView.postDelayed({
                    if (!window.decorView.hasWindowFocus() && focusStayedInApp()) lock.onFocus(true)
                }, delay)
            }
        }
    }

    /**
     * Whether another window of this app (a dialog, a menu) holds input focus.
     * Below API 29 there is no way to tell, so assume it did: only a pause
     * covers there, and an in-app dialog never blanks the chat behind it.
     */
    private fun focusStayedInApp(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        val decor = window.decorView
        return WindowInspector.getGlobalWindowViews().any { it !== decor && it.hasWindowFocus() }
    }

    private companion object {
        /** When to look again for an in-app popup that took focus late. */
        val FOCUS_RECHECK_MS = longArrayOf(50, 150, 400)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data?.let(DeepLink::from)?.let { incomingLink.value = it }
            Intent.ACTION_SEND -> {
                // Only plain text and links; files and images are not taken (no URI read permission asked).
                val text = SharedText.from(
                    intent.type,
                    intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
                    intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT),
                ) ?: return
                (application as NekkoApp).shareInbox.offer(text)
                incomingLink.value = DeepLink.Share
            }
        }
    }

    override fun onDestroy() {
        (application as NekkoApp).ownerCheck.detach(authenticator)
        super.onDestroy()
    }
}

private fun DeepLink.Companion.from(uri: Uri): DeepLink? =
    from(uri.toString(), uri.scheme, uri.host, uri.pathSegments.orEmpty())
