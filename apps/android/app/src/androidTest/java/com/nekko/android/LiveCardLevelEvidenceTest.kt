package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.connection.KeepAlive
import com.nekko.android.connection.LiveCards
import com.nekko.android.data.PhonePrefs
import com.nekko.android.data.PrefStore
import com.nekko.android.ui.settings.ConnectionSection
import com.nekko.android.ui.settings.SettingsDeps
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.LiveLevel
import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Settings → Connection's Lock Screen card at each level, for a before/after
 * pair (#2933). Compiles against both revisions: only `ConnectionSection(deps)`,
 * `KeepAlive.ENABLED` and `LiveCards.LEVEL`. Writes `live-card-<level>-<revision>.png`
 * to the app's external files under `evidence/`; pass `-e nekkoRevision before`
 * on the base revision. Emulator only.
 */
@RunWith(AndroidJUnit4::class)
class LiveCardLevelEvidenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun eachLevel() {
        assumeTrue("Only an emulator may run this test", Build.HARDWARE in listOf("ranchu", "goldfish"))
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        val prefs = PhonePrefs(object : PrefStore {
            val map = HashMap<String, String>()
            override fun getString(name: String) = map[name]
            override fun putString(name: String, value: String?) { if (value == null) map.remove(name) else map[name] = value }
        })
        prefs.set(KeepAlive.ENABLED, true)
        prefs.set(LiveCards.LEVEL, LiveLevel.NONE)
        val deps = SettingsDeps(app.computers, app.themePrefs, prefs, open = {})
        compose.setContent { NekkoTheme(dark = false) { Column(Modifier) { ConnectionSection(deps) } } }
        val revision = InstrumentationRegistry.getArguments().getString("nekkoRevision", "after")
        val dir = File(compose.activity.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        for (level in LiveLevel.entries) {
            compose.runOnUiThread { prefs.set(LiveCards.LEVEL, level) }
            compose.waitForIdle()
            Thread.sleep(800)
            compose.waitForIdle()
            var shot: Bitmap? = null
            for (i in 0 until 10) {
                shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                if (shot != null) break
                Thread.sleep(300)
            }
            File(dir, "live-card-${level.wire}-$revision.png").outputStream().use { shot!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
