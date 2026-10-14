package com.nekko.android

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
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
    /** The latest link opened from outside the app; the nav host consumes it. */
    private val incomingLink = MutableStateFlow<DeepLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity must not replay the link it was first opened with.
        if (savedInstanceState == null) handle(intent)
        val app = application as NekkoApp
        val repo = app.computers
        val authenticator = Authenticator(this)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) { app.appLock.enabled.collect(::hideFromRecents) }
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
                            incomingLink = incomingLink,
                            onLinkHandled = { incomingLink.value = null },
                        )
                    }
                }
            }
        }
    }

    /**
     * With the lock on, the recent-apps preview must not show chats. Only
     * FLAG_SECURE does that reliably: setRecentsScreenshotEnabled(false) still
     * lets the overview show the live window when it is opened from the app
     * (seen on API 37). The cost: no screenshots or screen recording of the app
     * while the lock is on; turning the lock off lifts both.
     */
    private fun hideFromRecents(hide: Boolean) {
        if (hide) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
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
}

private fun DeepLink.Companion.from(uri: Uri): DeepLink? =
    from(uri.toString(), uri.scheme, uri.host, uri.pathSegments.orEmpty())
