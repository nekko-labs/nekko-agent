package com.nekko.android

import android.content.res.Configuration
import android.graphics.Bitmap
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.theme.NekkoTheme
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #2450: the formatting toolbar rides on the keyboard. It shows with the soft keyboard,
 * sits on its top edge, and goes when the keyboard goes. Full-screen frames (the IME
 * included) go to the app's external files (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class ComposerKeyboardBarTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "light"

    @Test
    fun toolbarOpensAndClosesWithTheKeyboard() {
        // The emulator always reports a QWERTY device (keysexposed-qwerty, even with hw.keyboard=no),
        // which the composer reads as a hardware keyboard. Test the phone case: no keys, and the
        // soft keyboard allowed to show.
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("settings put secure show_ime_with_hard_keyboard 1").close()
        val noKeys = Configuration(compose.activity.resources.configuration).apply {
            keyboard = Configuration.KEYBOARD_NOKEYS
            hardKeyboardHidden = Configuration.HARDKEYBOARDHIDDEN_YES
        }
        compose.activityRule.scenario.onActivity {
            it.enableEdgeToEdge()
            @Suppress("DEPRECATION")
            it.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        compose.setContent {
            CompositionLocalProvider(LocalConfiguration provides noKeys) { NekkoTheme(dark = theme == "dark") {
                // As the chat lays it out (ChatColumns): the composer last, above the IME.
                Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
                    Spacer(Modifier.weight(1f))
                    Composer(
                        running = false,
                        blocked = null,
                        queued = emptyList(),
                        onSend = { _, _, _ -> },
                        onStop = {},
                        modifier = Modifier.navigationBarsPadding(),
                    )
                }
            } }
        }
        frames("kbbar-0-closed", 1)
        assertTrue("no bar before the box is used", compose.onAllNodesWithTagCount("composer.keyboardBar") == 0)

        compose.onNode(hasContentDescription("Message")).performClick()
        frames("kbbar-1-opening", 4)
        waitFor("the soft keyboard opens") { imeShown() }
        compose.onNode(hasContentDescription("Message")).performTextInput("Ship **today**")
        compose.waitForIdle()
        Thread.sleep(800)
        frames("kbbar-2-open", 1)
        waitFor("the bar shows with it") { compose.onAllNodesWithTagCount("composer.keyboardBar") == 1 }
        // On the keyboard's top edge: the bar's foot within a few pixels of the IME's top.
        val bar = compose.onNodeWithTag("composer.keyboardBar").fetchSemanticsNode().boundsInWindow
        val root = compose.activity.window.decorView
        val ime = ViewCompat.getRootWindowInsets(root)!!.getInsets(WindowInsetsCompat.Type.ime()).bottom
        val imeTop = root.height - ime
        assertTrue("bar foot ${bar.bottom} vs keyboard top $imeTop", kotlin.math.abs(bar.bottom - imeTop) <= 4f)

        compose.activityRule.scenario.onActivity { WindowInsetsControllerCompat(it.window, it.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
        frames("kbbar-3-closing", 4)
        waitFor("the soft keyboard closes") { !imeShown() }
        waitFor("the bar goes with it") { compose.onAllNodesWithTagCount("composer.keyboardBar") == 0 }
        Thread.sleep(600)
        frames("kbbar-4-closed", 1)
    }

    private fun imeShown(): Boolean {
        var shown = false
        compose.activityRule.scenario.onActivity {
            shown = ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        return shown
    }

    private fun waitFor(what: String, check: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < until) {
            compose.waitForIdle()
            if (check()) return
            Thread.sleep(100)
        }
        throw AssertionError(what)
    }

    private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onAllNodesWithTagCount(tag: String): Int =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().size

    /** Whole-screen frames (the keyboard is another window, so captureToImage misses it). */
    private fun frames(name: String, count: Int) {
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
        repeat(count) { i ->
            val shot = ui.takeScreenshot() ?: return@repeat
            val file = File(dir, if (count == 1) "$theme-$name.png" else "$theme-$name-${i + 1}.png")
            file.outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
