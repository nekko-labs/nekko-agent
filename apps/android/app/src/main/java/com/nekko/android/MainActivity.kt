package com.nekko.android

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nekko.android.ui.NekkoNavHost
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.ThemeResolver
import kotlinx.coroutines.flow.MutableStateFlow

/** The only activity. Deep links (pairing QR from the system camera) arrive here too. */
class MainActivity : ComponentActivity() {
    /** The latest link opened from outside the app; the nav host consumes it. */
    private val incomingLink = MutableStateFlow<DeepLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity must not replay the link it was first opened with.
        if (savedInstanceState == null) handle(intent)
        val app = application as NekkoApp
        val repo = app.computers
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
                NekkoNavHost(
                    repo = repo,
                    themePrefs = app.themePrefs,
                    phonePrefs = app.phonePrefs,
                    incomingLink = incomingLink,
                    onLinkHandled = { incomingLink.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        DeepLink.from(uri)?.let { incomingLink.value = it }
    }
}

private fun DeepLink.Companion.from(uri: Uri): DeepLink? =
    from(uri.toString(), uri.scheme, uri.host, uri.pathSegments.orEmpty())
