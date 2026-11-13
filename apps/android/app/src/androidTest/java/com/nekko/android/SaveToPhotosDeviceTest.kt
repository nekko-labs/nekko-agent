package com.nekko.android

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Environment
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.PhotoViewer
import com.nekko.android.ui.chat.ViewerPhoto
import com.nekko.android.ui.theme.NekkoTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

/**
 * Save to Photos on every Android the app runs on (#2111 follow-up). Android 10 and later save
 * with no question. Android 9 asks for storage access the first time: said no, the viewer says
 * why nothing was saved; once allowed, the photo lands in Pictures/Nekko. Screenshots in
 * `evidence/save-<sdk>-*.png`.
 */
class SaveToPhotosDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val ui get() = InstrumentationRegistry.getInstrumentation().uiAutomation
    private val pkg get() = ApplicationProvider.getApplicationContext<android.content.Context>().packageName

    private fun photo(): String {
        val b = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(0x5b, 0x8d, 0xef)) }
        val out = ByteArrayOutputStream()
        b.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray())
    }

    private fun saved(): Boolean = compose.onAllNodes(hasText("Saved to Photos"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test fun saveWorksOnThisAndroid() {
        val url = photo()
        compose.setContent { NekkoTheme(dark = false) { PhotoViewer(listOf(ViewerPhoto(url)), 0, label = { "Photo 1" }, onDismiss = {}) } }
        compose.waitForIdle()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Android 9: the first Save asks; saying no saves nothing and says why.
            shell("pm revoke $pkg ${Manifest.permission.WRITE_EXTERNAL_STORAGE}")
            shell("rm -rf ${nekkoPictures().path}")
            compose.onNodeWithTag("photo.actions").performClick()
            compose.waitForIdle()
            shot("1-menu")
            compose.onNodeWithTag("photo.save").performClick()
            Thread.sleep(1_500)
            shot("2-asks")
            tapSystemButton("DENY")
            compose.waitUntil(5_000) { compose.onAllNodes(hasText("Allow storage access to save it to Photos."), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            shot("3-refused")
            assertTrue("nothing saved after no", !nekkoPictures().exists() || nekkoPictures().list().isNullOrEmpty())
            // Asked again on the next Save; this time allowed, and the photo is saved straight away.
            compose.onNodeWithTag("photo.actions").performClick()
            compose.waitForIdle()
            compose.onNodeWithTag("photo.save").performClick()
            Thread.sleep(1_500)
            shot("4-asks-again")
            tapSystemButton("ALLOW")
            compose.waitUntil(5_000) { saved() }
            shot("5-saved")
            assertTrue("the photo is in Pictures/Nekko: ${nekkoPictures().list()?.toList()}", nekkoPictures().listFiles()?.any { it.name.startsWith("Photo ") && it.length() > 0 } == true)
            // From now on Save asks nothing.
            Thread.sleep(2_500)
        }
        compose.onNodeWithTag("photo.actions").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("photo.save").performClick()
        compose.waitUntil(5_000) { saved() }
        shot("6-saved-no-question")
    }

    @Suppress("DEPRECATION")
    private fun nekkoPictures() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Nekko")

    private fun shell(cmd: String): String =
        android.os.ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(cmd)).use { it.readBytes().toString(Charsets.UTF_8) }

    /** Tap a button of the system's permission dialog by its label: it is not this app's, so not in Compose. */
    private fun tapSystemButton(label: String) {
        for (attempt in 0 until 20) {
            val button = ui.rootInActiveWindow?.findAccessibilityNodeInfosByText(label)?.firstOrNull { it.isClickable }
            if (button != null) {
                button.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
                Thread.sleep(1_000)
                return
            }
            Thread.sleep(500)
        }
        error("No $label button on screen")
    }

    private fun shot(name: String) {
        Thread.sleep(300)
        val bitmap = ui.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "save-${Build.VERSION.SDK_INT}-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
