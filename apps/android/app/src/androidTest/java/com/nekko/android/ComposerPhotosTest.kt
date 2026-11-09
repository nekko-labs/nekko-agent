package com.nekko.android

import android.graphics.Bitmap
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.chat.PhotoTray
import com.nekko.android.ui.chat.AttachUi
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.theme.NekkoTheme
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Draft photos sit inside the message box, with the text, as on the iPhone
 * (#2043). The screenshot goes to the app's external files (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class ComposerPhotosTest {
    @get:Rule val compose = createComposeRule()

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "dark"

    @Test
    fun photoThumbnailsSitInsideTheMessageBox() {
        val tray = PhotoTray<ImageBitmap>()
        tray.seed(listOf(0xFF854F6C.toInt(), 0xFF3A7CA5.toInt()).mapIndexed { i, c -> "data:image/jpeg;base64,$i" to solid(c) })
        compose.setContent {
            NekkoTheme(dark = theme == "dark") {
                Composer(
                    running = false,
                    blocked = null,
                    queued = emptyList(),
                    onSend = { _, _, _ -> },
                    onStop = {},
                    initialText = "What is in these?",
                    attach = AttachUi(
                        state = tray.state.collectAsState().value,
                        onPickFiles = {},
                        onTakePhoto = null,
                        onRemove = {},
                        take = { emptyList() },
                        restore = {},
                        clearError = {},
                    ),
                    modifier = Modifier.width(360.dp),
                )
            }
        }
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-composer-photos.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }

        val card = compose.onNodeWithTag("composer.card").getBoundsInRoot()
        for (n in 1..2) {
            val photo = compose.onNodeWithContentDescription("Photo $n").getBoundsInRoot()
            assertTrue("photo $n $photo inside the box $card",
                photo.left >= card.left && photo.right <= card.right && photo.top >= card.top && photo.bottom <= card.bottom)
        }
    }

    private fun solid(color: Int): ImageBitmap =
        Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }.asImageBitmap()
}
