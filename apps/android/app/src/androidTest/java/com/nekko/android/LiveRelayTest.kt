package com.nekko.android

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.theme.ThemeChoice
import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app on an emulator against a real relay, a headless agent and the fake
 * model (apps/ios/scripts/itest-stack.sh, reached through `adb reverse`): pair
 * by pasting the link, start a chat, watch the reply stream in, deny a guarded
 * tool and answer the agent's question. Every step is a screenshot under the
 * app's external files (`evidence/`), pulled by CI.
 *
 * Opt-in: CI passes `-e nekkoLink <pairing link>` (and `-e nekkoTheme dark`);
 * without it this is skipped.
 */
@RunWith(AndroidJUnit4::class)
class LiveRelayTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val args = InstrumentationRegistry.getArguments()
    private val theme = args.getString("nekkoTheme") ?: "light"

    @Test
    fun pairStreamDenyAndAnswerFromThePhone() {
        val link = args.getString("nekkoLink")
        assumeTrue("pass -e nekkoLink (apps/ios/scripts/itest-stack.sh)", !link.isNullOrBlank())
        val app = ApplicationProvider.getApplicationContext<NekkoApp>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        if (Build.VERSION.SDK_INT >= 33) {
            instrumentation.uiAutomation.grantRuntimePermission(app.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        instrumentation.runOnMainSync {
            // A test device has no enrolled biometrics; the lock is covered by unit tests.
            app.appLock.setEnabled(false)
            app.themePrefs.set(if (theme == "dark") ThemeChoice.DARK else ThemeChoice.LIGHT)
        }

        ActivityScenario.launch(MainActivity::class.java).use {
            waitFor(hasText("Pair a computer"))
            shot("0-welcome")
            tap(hasText("Pair a computer"))

            waitFor(hasText("Pairing link"))
            compose.onNode(hasText("Pairing link")).performTextInput(link!!)
            shot("1-pair")
            tap(hasText("Pair"))

            waitFor(hasText("New chat"), 30_000)
            shot("2-chats")
            tap(hasText("New chat"))

            waitFor(hasText("Start on", substring = true), 20_000)
            shot("3-new-chat")
            tap(hasText("Start on", substring = true))

            send("Say hello")
            waitFor(hasText("Hello from your computer."), 30_000)
            shot("4-reply")

            send("please approve a cleanup")
            waitFor(hasText("Deny"), 30_000)
            shot("5-approval")
            tap(hasText("Deny"))
            waitGone(hasText("Deny"), 15_000)
            shot("6-denied")

            send("ask me which platform")
            waitFor(hasText("Which platform should I build first?"), 30_000)
            shot("6b-question")
            tap(hasText("iOS"))
            tap(hasText("Submit"))
            waitGone(hasText("Which platform should I build first?"), 15_000)
            shot("7-answered")
        }
    }

    /**
     * Tap what the user sees (a label or an icon's description) rather than the
     * clickable node that merges it: a touch at its centre lands on its button,
     * whatever shape the component's semantics take.
     */
    private fun tap(matcher: SemanticsMatcher) {
        waitFor(matcher)
        compose.onAllNodes(matcher, useUnmergedTree = true).onFirst().performClick()
    }

    private fun send(text: String) {
        val box = hasContentDescription("Message")
        waitFor(box, 15_000)
        compose.onNode(box).performClick()
        compose.onNode(box).performTextInput(text)
        tap(hasContentDescription("Send"))
    }

    private fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 10_000) {
        try {
            compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: ComposeTimeoutException) {
            shot("failed-waiting")
            throw AssertionError("never saw ${matcher.description}", e)
        }
    }

    private fun waitGone(matcher: SemanticsMatcher, timeoutMs: Long) {
        compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
