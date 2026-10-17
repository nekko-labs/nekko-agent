package com.nekko.android

import android.graphics.Bitmap
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.chat.MicUi
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.voice.MicState
import com.nekko.protocol.SkillSummary
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The empty message box (placeholder showing, `/ for skills` hint) is as tall
 * as one with a line typed, on a narrow phone with large text. Screenshots go
 * to the app's external files (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class ComposerHeightTest {
    @get:Rule val compose = createComposeRule()

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "dark"

    @Test
    fun emptyBoxIsOneLineTall() {
        val skill = SkillSummary(name = "review", description = "Review a change", category = "code", source = "builtin")
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale = 1.3f)) {
                NekkoTheme(dark = theme == "dark") {
                    Composer(
                        running = false,
                        blocked = null,
                        queued = emptyList(),
                        onSend = { _, _, _ -> },
                        onStop = {},
                        mic = MicUi(MicState.Idle, error = null, computerName = "Mac", onTap = {}),
                        skills = listOf(skill),
                        modifier = Modifier.width(360.dp),
                    )
                }
            }
        }
        val empty = shot("composer-empty")
        compose.onNode(hasContentDescription("Message")).performTextInput("Now is perfect")
        val typed = shot("composer-typed")
        assertEquals("empty box height (px) vs one typed line", typed, empty)
    }

    private fun shot(name: String): Int {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap.height
    }
}
