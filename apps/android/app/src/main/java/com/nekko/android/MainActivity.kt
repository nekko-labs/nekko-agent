package com.nekko.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.nekko.android.ui.NekkoNavHost
import com.nekko.android.ui.theme.NekkoTheme
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
        val uri = intent.data ?: return
        DeepLink.from(uri)?.let { incomingLink.value = it }
    }
}

private fun DeepLink.Companion.from(uri: Uri): DeepLink? =
    from(uri.toString(), uri.scheme, uri.host, uri.pathSegments.orEmpty())
