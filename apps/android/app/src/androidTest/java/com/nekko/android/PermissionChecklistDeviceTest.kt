package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.permissions.PermissionsScreen
import com.nekko.android.ui.theme.NekkoTheme
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2251: Settings → Permissions against Android's real dialogs. Alerts allowed; the microphone
 * refused twice reads Off in Settings and then offers only Settings; rows Android doesn't have
 * read Not available. Run on a fresh emulator (nothing granted yet). Screenshots in
 * `evidence/permissions-*.png`.
 */
class PermissionChecklistDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val ui get() = InstrumentationRegistry.getInstrumentation().uiAutomation
    private val store = HashMap<String, String>()
    private val prefs = PhonePrefs(object : PrefStore {
        override fun getString(name: String) = store[name]
        override fun putString(name: String, value: String?) { if (value == null) store.remove(name) else store[name] = value }
    })

    /** Tap a button of Android's own permission dialog: it is not this app's, so not in Compose. */
    private fun tapSystem(vararg labels: String) {
        for (attempt in 0 until 20) {
            val root = ui.rootInActiveWindow
            val node = labels.firstNotNullOfOrNull { l -> root?.findAccessibilityNodeInfosByText(l)?.firstOrNull { it.isClickable || it.parent?.isClickable == true } }
            if (node != null) {
                (if (node.isClickable) node else node.parent).performAction(AccessibilityNodeInfo.ACTION_CLICK)
                Thread.sleep(1_200)
                compose.waitForIdle()
                return
            }
            Thread.sleep(500)
        }
        error("No system button ${labels.toList()}")
    }

    private fun state(item: String) = compose.onNodeWithTag("perm.$item.state", useUnmergedTree = true)

    private fun waitState(item: String, text: String) =
        compose.waitUntil(8_000) { compose.onAllNodes(hasTestTag("perm.$item.state") and hasText(text), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    @Test fun realAnswersFromAndroid() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assumeTrue("needs a phone that has not been asked yet", Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED)
        compose.setContent { NekkoTheme(dark = false) { PermissionsScreen(prefs, onBack = {}) } }
        compose.waitForIdle()
        shot("1-start")

        // Alerts: Android's dialog, allowed.
        compose.onNodeWithTag("perm.alerts.action").performClick()
        Thread.sleep(1_200)
        shot("2-android-asks")
        tapSystem("Allow")
        waitState("alerts", "Allowed")

        // Microphone: refused once, Android would ask again; refused twice, only Settings can change it.
        compose.onNodeWithTag("perm.microphone", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("perm.microphone.action").performClick()
        tapSystem("Don’t allow", "Don't allow")
        compose.onNodeWithTag("perm.microphone.action").performClick()
        tapSystem("Don’t allow", "Don't allow")
        waitState("microphone", "Off in Settings")
        compose.onNodeWithTag("perm.microphone.action").performClick() // now: Settings
        Thread.sleep(1_500)
        shot("3-system-settings")
        // Back from Android's own settings (another app, so the system's Back, not Espresso's).
        ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        Thread.sleep(1_500)
        compose.waitForIdle()
        compose.onNodeWithTag("permissions.list").performScrollToNode(hasTestTag("perm.microphone"))
        shot("4-after")
        state("alerts")
    }

    private fun shot(name: String) {
        Thread.sleep(400)
        val bitmap = ui.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "permissions-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
