package com.nekko.android

import android.Manifest
import android.graphics.Bitmap
import android.os.Build
import android.view.KeyEvent
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // First run, step 1: what the app does; step 2 is pairing.
            waitFor(hasText("Step 1 of 3"))
            shot("0-first-run")
            tap(hasText("Continue"))
            waitFor(hasText("Pair a computer"))
            waitFor(hasText("Step 2 of 3"))
            shot("0-welcome")
            tap(hasText("Pair a computer"))

            waitFor(hasText("Pairing link"))
            compose.onNode(hasText("Pairing link")).performTextInput(link!!)
            // The keyboard covers the Pair button on a small screen; a user closes it first.
            hideKeyboard(scenario)
            shot("1-pair")
            // The button moves while the keyboard slides away (imePadding), so a
            // touch at its old centre can miss; click it through its semantics.
            click(hasText("Pair"))

            // Step 3, right after the first pairing: notifications (granted above, so nothing is asked).
            waitFor(hasText("Step 3 of 3"), 30_000)
            shot("1a-first-run-notifications")
            tap(hasText("Allow notifications"))

            waitFor(hasText("New chat"), 30_000)
            shot("2-chats")
            tap(hasText("New chat"))

            waitFor(hasText("Start on", substring = true), 20_000)
            shot("3-new-chat")
            tap(hasText("Start on", substring = true))

            send("Say hello")
            waitFor(hasText("Hello from your computer."), 30_000)
            shot("4-reply")

            // + sits inside the message box and offers another agent or a terminal, as on the desktop.
            tap(hasContentDescription("Add"))
            waitFor(hasText("New agent"))
            waitFor(hasText("Terminal"))
            screenShot("4a-plus-menu")
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            waitGone(hasText("New agent"), 5_000)

            // A Markdown reply: heading, lists, a code block with its Copy button, a link.
            send("show me markdown")
            waitFor(hasContentDescription("Copy code"), 30_000)
            waitFor(hasText("Build steps"))
            shot("4b-markdown")

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

            // The agent writes a file; the phone reads the change, read only (the
            // stack turns the computer's "Let phones see changes" on).
            // The small emulator screen may not compose the new tool row, so wait
            // for the turn to end (no Stop button) rather than for the row.
            send("write a note")
            Thread.sleep(3_000)
            waitGone(hasContentDescription("Stop"), 30_000)
            tap(hasContentDescription("Changes"))
            waitFor(hasContentDescription("nekko-itest-note.txt, new file, 2 added", substring = true), 45_000)
            waitFor(hasText("Read only", substring = true))
            shot("8-changes")

            // Ask about a change: the quote lands in the message box, unsent, and the sheet closes.
            val change = SemanticsMatcher.keyIsDefined(SemanticsActions.OnLongClick) and hasAnyDescendant(hasContentDescription("Added line 2", substring = true))
            waitFor(change)
            compose.onAllNodes(change, useUnmergedTree = true).onFirst().performSemanticsAction(SemanticsActions.OnLongClick)
            waitFor(hasText("+written by the agent", substring = true), 10_000)
            shot("8b-asked")

            // Settings → Connection status: the route, the status and what happened.
            hideKeyboard(scenario)
            tap(hasContentDescription("Back"))
            tap(hasContentDescription("Settings"))
            val status = hasText("CONNECTION STATUS")
            waitFor(hasScrollAction())
            compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(status)
            waitFor(hasText("Online"), 10_000)
            compose.onAllNodes(hasScrollAction()).onFirst().performScrollToNode(hasText("Since the app started"))
            shot("9-connection")
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

    private fun click(matcher: SemanticsMatcher) {
        // The merged node: a Button carries its label's text and the click.
        val button = matcher and hasClickAction()
        compose.waitUntil(10_000) { compose.onAllNodes(button).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(button).onFirst().performSemanticsAction(SemanticsActions.OnClick)
    }

    private fun hideKeyboard(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { a -> WindowCompat.getInsetsController(a.window, a.window.decorView).hide(WindowInsetsCompat.Type.ime()) }
        // Wait for the keyboard to be gone, not just asked to go.
        compose.waitUntil(5_000) {
            var open = true
            scenario.onActivity { a ->
                open = ViewCompat.getRootWindowInsets(a.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
            }
            !open
        }
        compose.waitForIdle()
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
            // What was on screen instead, for runs whose screenshots aren't at hand.
            val screen = runCatching { compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = 40) }.getOrElse { it.toString() }
            throw AssertionError("never saw ${matcher.description}; on screen:\n$screen", e)
        }
    }

    private fun waitGone(matcher: SemanticsMatcher, timeoutMs: Long) {
        compose.waitUntil(timeoutMs) { compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    /** The whole screen, popups included (a menu is its own window, outside [shot]'s root). */
    private fun screenShot(name: String) {
        compose.waitForIdle()
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
