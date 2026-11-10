package com.nekko.android

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.nekko.android.lock.AppLock
import com.nekko.android.lock.Authenticator
import com.nekko.android.lock.LockGate
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme

/**
 * The real [LockGate] over a stand-in for the app (#2120): the pixel opening on the plum,
 * the phone's own unlock prompt over it, Unlock after a cancel, the zoom into the app.
 * Debug source set only; no pairing, no relay. [lock] is the test's handle.
 */
class LockEvidenceActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val auth = Authenticator(this)
        val appLock = AppLock(true).also { lock = it }
        setContent {
            NekkoTheme(dark = false) {
                LockGate(appLock, auth) {
                    Column(Modifier.fillMaxSize().background(Nekko.palette.paper).systemBarsPadding().padding(24.dp)) {
                        Text("Chats", style = MaterialTheme.typography.headlineMedium, color = Nekko.palette.ink)
                        listOf("Tidy the release notes", "Profile the image cache", "Plan the week").forEach {
                            Text(it, style = MaterialTheme.typography.titleMedium, color = Nekko.palette.ink, modifier = Modifier.padding(top = 20.dp))
                        }
                    }
                }
            }
        }
    }

    companion object {
        @Volatile var lock: AppLock? = null
    }
}
