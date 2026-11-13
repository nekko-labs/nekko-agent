package com.nekko.android

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.chat.LocalSessionPhoto
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Block
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

/**
 * #2111: a sent prompt's photos open full screen (the iPhone's ImageViewer): the small copy at
 * once, the computer's full photo after, zoom, Copy and Save, paging, and a swipe down to close.
 * Screenshots in `evidence/photo-*.png`.
 */
class PhotoViewerDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** A picture that shows its sharpness: a gradient with a label and fine stripes. */
    private fun photo(w: Int, h: Int, label: String, from: Int, to: Int): String {
        val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        c.drawRect(0f, 0f, w.toFloat(), h.toFloat(), Paint().apply { shader = LinearGradient(0f, 0f, w.toFloat(), h.toFloat(), from, to, Shader.TileMode.CLAMP) })
        val line = Paint().apply { color = 0x66FFFFFF; strokeWidth = (w / 400f).coerceAtLeast(1f) }
        var x = 0f
        while (x < w) { c.drawLine(x, h * 0.7f, x, h * 0.9f, line); x += w / 80f }
        c.drawText(label, w * 0.08f, h * 0.45f, Paint().apply { color = 0xFFFFFFFF.toInt(); textSize = h / 7f; isAntiAlias = true; isFakeBoldText = true })
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray())
    }

    private val small = listOf(photo(96, 72, "Kitchen", 0xFF5B8DEF.toInt(), 0xFFA57CF0.toInt()), photo(96, 72, "Garden", 0xFF2FB7B1.toInt(), 0xFF7F8CF5.toInt()))
    private val full = listOf(photo(1600, 1200, "Kitchen", 0xFF5B8DEF.toInt(), 0xFFA57CF0.toInt()), photo(1600, 1200, "Garden", 0xFF2FB7B1.toInt(), 0xFF7F8CF5.toInt()))
    private val asked = mutableListOf<Pair<String, Int>>()

    private fun show() {
        compose.setContent {
            NekkoTheme(dark = false) {
                // The computer's session:photo, a little slow so the small copy shows first.
                CompositionLocalProvider(LocalSessionPhoto provides { id, i -> asked += id to i; delay(1_500); full[i] }) {
                    Box(Modifier.fillMaxSize().padding(16.dp)) {
                        BlockView(Block.User("m1", "Which of these is sharper?", thumbs = small))
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun aSentPhotoOpensFullScreenZoomsCopiesSavesAndSwipesClosed() {
        show()
        shot("1-bubble")
        compose.onNodeWithTag("photo.thumb.0", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        // The small copy at once, with the spinner while the computer sends the full photo.
        compose.onNodeWithTag("photo.loading", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("1 of 2").assertExists()
        shot("2-small-copy")
        compose.waitUntil(5_000) { compose.onAllNodes(androidx.compose.ui.test.hasTestTag("photo.full"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf("m1" to 0), asked.distinct().take(1))
        shot("3-full")

        // Pinch to zoom.
        compose.onNodeWithTag("photo.viewer").performTouchInput {
            pinch(center - Offset(40f, 0f), center - Offset(300f, 0f), center + Offset(40f, 0f), center + Offset(300f, 0f))
        }
        compose.waitForIdle()
        shot("4-zoomed")
        // Double-tap back to the whole photo.
        compose.onNodeWithTag("photo.viewer").performTouchInput { doubleClick(center) }
        compose.waitForIdle()

        // Save: into Pictures/Nekko, no permission asked.
        compose.onNodeWithTag("photo.actions").performClick()
        compose.waitForIdle()
        shot("5-actions")
        compose.onNodeWithTag("photo.save").performClick()
        compose.waitUntil(3_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("Saved to Photos"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        shot("6-saved")

        // Copy: the photo itself on the clipboard, through the app's FileProvider.
        compose.onNodeWithTag("photo.actions").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("photo.copy").performClick()
        compose.waitUntil(3_000) { compose.onAllNodes(androidx.compose.ui.test.hasText("Copied"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val cm = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
            val uri = cm.primaryClip?.getItemAt(0)?.uri
            assertTrue("the clipboard holds the photo, not text: $uri", uri?.toString()?.contains(".photos/photos/photo.png") == true)
        }

        // Let the system's clipboard preview go before paging.
        Thread.sleep(3_000)

        // Sideways: the next photo, which the computer is asked for too.
        compose.onNodeWithTag("photo.viewer").performTouchInput { swipeLeft() }
        compose.waitForIdle()
        compose.onNodeWithText("2 of 2").assertExists()
        compose.waitUntil(5_000) { asked.any { it == "m1" to 1 } }
        Thread.sleep(1_800)
        compose.waitForIdle()
        shot("7-second")

        // Down: the viewer closes, back to the chat.
        compose.onNodeWithTag("photo.viewer").performTouchInput { swipeDown(startY = centerY, endY = bottom, durationMillis = 250) }
        compose.waitForIdle()
        compose.onNodeWithTag("photo.viewer").assertDoesNotExist()
        shot("8-closed")
    }

    private fun shot(name: String) {
        Thread.sleep(300)
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "photo-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
