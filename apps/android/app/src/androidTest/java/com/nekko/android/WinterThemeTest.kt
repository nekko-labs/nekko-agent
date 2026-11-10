package com.nekko.android

import android.graphics.Bitmap
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.ChatMascot
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.android.ui.theme.ThemeChoice
import com.nekko.android.ui.theme.ThemeResolver
import com.nekko.protocol.Appearance
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Overlay this file alone on base and head. Uses only pre-seasonal APIs, never copies new
 * decoration code onto base. Composed native fixture with the production theme and mascot.
 * Fits the actual emulator viewport, including folded, unfolded and landscape windows.
 * Evidence script disables animations; the static test explicitly checks that system setting.
 */
@RunWith(AndroidJUnit4::class)
class WinterThemeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val args get() = InstrumentationRegistry.getArguments()

    @Test fun seasonalThemesGreetingAndSwitchAway() {
        val preset = mutableStateOf("winter")
        var refreshes = 0
        compose.setContent {
            val look = ThemeResolver.resolve(ThemeChoice.COMPUTER,
                Appearance(Appearance.ThemeMode.DARK, preset = preset.value), systemDark = false)
            NekkoTheme(dark = look.dark, accent = look.accent, preset = look.preset) {
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).padding(20.dp).testTag("winter.fixture")) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ChatMascot(working = false, refreshing = false, onRefresh = { refreshes++ })
                        Spacer(Modifier.width(8.dp))
                        Text("Winter planning", color = Nekko.palette.ink)
                    }
                    Spacer(Modifier.height(40.dp))
                    Text("A little room for a fresh idea.", color = Nekko.palette.inkSoft)
                    Spacer(Modifier.weight(1f))
                    Text("Nekko Agent", color = Nekko.palette.inkFaint)
                }
            }
        }
        settle()
        shot("winter-theme")
        val mascot = compose.onNodeWithTag("chat.mascot")
        mascot.assertHasClickAction().performClick()
        // The theme overlay must not intercept the real button or remove its greeting.
        mascot.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription,
            compose.activity.getString(R.string.mascot_hello)))
        shot("winter-greeting")
        val actions = mascot.fetchSemanticsNode().config[SemanticsActions.CustomActions]
        compose.runOnIdle {
            assertEquals(1, actions.size)
            assertTrue(actions.single().action())
        }
        assertEquals(1, refreshes)
        // Greeting delay runs on Compose's test scheduler, not wall-clock sleep.
        compose.mainClock.advanceTimeBy(1_500)
        compose.waitForIdle()
        mascot.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription,
            compose.activity.getString(R.string.chats_idle)))
        for (id in listOf("autumn", "dark", "winter")) {
            compose.runOnIdle { preset.value = id }
            settle()
            shot("switch-$id")
            mascot.assertHasClickAction()
        }
        // Snow must not add any accessible copy or extra greeting targets.
        compose.onAllNodesWithTag("chat.mascot").assertCountEquals(1)
    }

    @Test fun reducedMotionIsStaticAndSurvivesStoppedLifecycle() {
        val resolver = compose.activity.contentResolver
        val original = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        // Only the disposable instrumentation device is changed, and always restored.
        fun scale(value: Float) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "settings put global animator_duration_scale $value").use { descriptor ->
                android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).readBytes()
            }
        }
        try {
            scale(0f)
            compose.setContent {
                val look = ThemeResolver.resolve(ThemeChoice("winter"), null, false)
                NekkoTheme(dark = look.dark, preset = look.preset) {
                    Box(Modifier.fillMaxSize().background(Nekko.palette.paper).testTag("winter.static")) {
                        ChatMascot(false, false, {}, Modifier.align(Alignment.TopStart).padding(20.dp))
                    }
                }
            }
            settle()
            assertEquals(0f, Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE), 0f)
            val first = compose.onNodeWithTag("winter.static").captureToImage().asAndroidBitmap()
            Thread.sleep(400)
            val second = compose.onNodeWithTag("winter.static").captureToImage().asAndroidBitmap()
            assertTrue("Reduced-motion composition must remain fixed", first.sameAs(second))
            shot("winter-reduced-motion")
            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            Thread.sleep(300)
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            settle()
            val resumed = compose.onNodeWithTag("winter.static").captureToImage().asAndroidBitmap()
            shot("winter-resumed")
            if (!first.sameAs(resumed)) {
                var changed = 0
                if (first.width == resumed.width && first.height == resumed.height) {
                    for (y in 0 until first.height) for (x in 0 until first.width) {
                        if (first.getPixel(x, y) != resumed.getPixel(x, y)) changed++
                    }
                }
                println("Winter resume pixels: first=${first.width}x${first.height}, resumed=${resumed.width}x${resumed.height}, changed=$changed")
            }
            assertTrue("Reduced-motion layout survives stop/start", first.sameAs(resumed))
        } finally {
            scale(original)
        }
    }

    private fun settle() { compose.waitForIdle(); Thread.sleep(200); compose.waitForIdle() }

    private fun shot(name: String) {
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val revision = args.getString("nekkoRevision") ?: "local"
        val device = args.getString("nekkoDevice") ?: "phone"
        // Synchronizes the native render; UIAutomation can capture the launch window.
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(dir, "$revision-$device-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
