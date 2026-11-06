package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.ui.settings.SimpleModeScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.THEME_PRESETS
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real settings/preview components, in-memory preferences, no computer or network. */
@RunWith(AndroidJUnit4::class)
class LightThemesTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightAndDarkPaletteEvidence() {
        val prefs = PhonePrefs(object : PrefStore {
            private val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        })
        val theme = mutableStateOf("x-plum-white")
        compose.setContent {
            NekkoTheme(dark = theme.value.endsWith("dark"), preset = THEME_PRESETS.first { it.id == theme.value }) {
                SimpleModeScreen(prefs, onBack = {})
            }
        }
        for (id in listOf("x-plum-white", "x-indigo-white", "x-plum-dark", "x-indigo-dark")) {
            compose.runOnIdle { theme.value = id }
            compose.waitForIdle()
            Thread.sleep(700)
            compose.waitForIdle()
            assertTrue(compose.onAllNodes(hasText("Simple is a cleaner, more focused view, and details show only when they matter. Everything still works.")).fetchSemanticsNodes().isNotEmpty())
            var shot: Bitmap? = null
            for (attempt in 0 until 10) {
                shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                if (shot != null) break
                Thread.sleep(300)
            }
            val bitmap = shot ?: error("No screenshot for $id")
            val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
            File(dir, "light-themes-$id.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
