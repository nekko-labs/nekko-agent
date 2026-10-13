package com.nekko.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.edit
import com.nekko.android.ui.NekkoNavHost
import com.nekko.android.ui.theme.NekkoTheme
import kotlinx.coroutines.flow.MutableStateFlow
import java.security.MessageDigest

/** The only activity. Deep links (pairing QR from the system camera) arrive here too. */
class MainActivity : ComponentActivity() {
    /** The latest link opened from outside the app; the nav host consumes it. */
    private val incomingLink = MutableStateFlow<DeepLink?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity must not replay the link it was first opened with.
        if (savedInstanceState == null) handle(intent)
        val repo = (application as NekkoApp).computers
        setContent {
            NekkoTheme {
                NekkoNavHost(repo = repo, incomingLink = incomingLink, onLinkHandled = { incomingLink.value = null })
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
        // Reopening the task from Recents replays its original intent, which
        // would bring back an old pairing prompt the user already answered.
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val uri = intent.data ?: return
        // The task keeps the link it was first opened with, and Android hands it
        // to every fresh activity (after an app update or process death without
        // saved state). A link is acted on once; pairing codes are single-use.
        val seen = linkFingerprint(uri.toString())
        val prefs = getSharedPreferences(LINK_PREFS, MODE_PRIVATE)
        if (prefs.getString(LAST_LINK, null) == seen) return
        prefs.edit { putString(LAST_LINK, seen) }
        DeepLink.from(uri)?.let { incomingLink.value = it }
    }

    private companion object {
        const val LINK_PREFS = "nekko_links"
        const val LAST_LINK = "last_handled"
    }
}

/** A one-way fingerprint: the raw link carries the pairing secret and must not be stored. */
internal fun linkFingerprint(raw: String): String =
    MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

private fun DeepLink.Companion.from(uri: Uri): DeepLink? =
    from(uri.toString(), uri.scheme, uri.host, uri.pathSegments.orEmpty())
