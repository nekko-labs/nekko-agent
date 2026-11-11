package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.data.SecureStore
import com.nekko.android.data.ThemePrefs
import com.nekko.android.ui.settings.AppearanceSection
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.ThemeChoice
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings → Appearance and its theme list (spec/phone/native-android-app.md, Themes): each
 * theme row leads with its icon in the theme's accent. Light and dark, with Spooky picked so the
 * Theme row shows its wizard hat. Each step is a whole-screen screenshot under the app's
 * external files (`evidence/`); native-mode-evidence.yml runs it against both revisions.
 */
@RunWith(AndroidJUnit4::class)
class ThemeIconsEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    @Test fun light() = capture(dark = false)

    @Test fun dark() = capture(dark = true)

    private fun capture(dark: Boolean) {
        val mode = if (dark) "dark" else "light"
        val themes = ThemePrefs(ApplicationProvider.getApplicationContext()).apply { set(ThemeChoice("autumn")) }
        val deps = SettingsDeps(repo(), themes, PhonePrefs(MemoryPrefs()), open = {})
        compose.setContent { NekkoTheme(dark = dark) { Column(Modifier.verticalScroll(rememberScrollState())) { AppearanceSection(deps) } } }
        settle()
        shot("1-appearance-$mode")
        compose.onNodeWithTag("settings.theme").performClick()
        settle()
        shot("2-list-$mode")
        compose.onAllNodes(hasScrollAction()).onLast().performScrollToNode(hasText("Spooky"))
        settle()
        shot("3-list-desktop-themes-$mode")
        compose.onAllNodes(hasScrollAction()).onLast().performScrollToNode(hasText("Tidepool"))
        settle()
        shot("4-list-experimental-$mode")
    }

    private fun repo() = ComputersRepository(
        store = MemoryStore(),
        remotes = { _, _ -> error("no computer in this test") },
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
        deviceName = { "Pixel" },
        deriveKey = { _, _ -> ByteArray(32) },
    )

    private fun settle() {
        compose.waitForIdle()
        Thread.sleep(700)
        compose.waitForIdle()
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
        File(dir, "theme-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private class MemoryStore : SecureStore {
        private val map = HashMap<String, String>()
        override suspend fun get(key: String) = map[key]
        override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    private class MemoryPrefs : PrefStore {
        val map = HashMap<String, String>()
        override fun getString(name: String) = map[name]
        override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
    }
}
