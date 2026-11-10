package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.chat.MicUi
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.voice.Engine
import com.nekko.android.voice.MicState
import com.nekko.android.voice.Wav
import java.io.File
import org.junit.Rule
import org.junit.Test

/**
 * #2110: the composer while it dictates in tap mode. It listens with no cap (the time
 * listened, not "/ 0:30") and says "Transcribing…" while earlier pauses' words are on their
 * way. A fixed state, no microphone. Screenshot `evidence/dictation-bar-<device>.png`.
 */
class DictationBarTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun tapModeListensWithNoCapWhilePiecesAreTranscribed() {
        val state = MicState.Recording(Engine.COMPUTER, Wav.SAMPLE_RATE * 65, 0.4f, continuous = true, transcribing = 1)
        compose.setContent {
            NekkoTheme(dark = false) {
                Surface(color = Nekko.palette.paper) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                        Composer(
                            running = false, blocked = null, queued = emptyList(), onSend = { _, _, _ -> }, onStop = {},
                            initialText = "Rename the settings screen and keep the old route working",
                            mic = MicUi(state, null, "Studio Mac") { },
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("Listening · 1:05", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Transcribing…", useUnmergedTree = true).assertExists()
        compose.waitForIdle()
        Thread.sleep(700)
        shot("dictation-bar")
    }

    private fun shot(name: String) {
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
