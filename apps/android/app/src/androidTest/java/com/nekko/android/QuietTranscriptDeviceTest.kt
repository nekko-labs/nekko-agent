package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.BlockView
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Block
import com.nekko.protocol.Voice
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2453: a continued chat's summary and the agent's progress notes fold away by default, as on
 * the iPhone (#2452); the prompt merged after the summary and the reply stay open. Runs on main
 * too (`-e nekkoRevision before`) for the matched before picture. Screenshots in
 * `evidence/quiet-*.png`.
 */
class QuietTranscriptDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val before = InstrumentationRegistry.getArguments().getString("nekkoRevision") == "before"

    private val summary = """Summary of the earlier conversation, compacted to save context:
- Task: tidy the settings page of the Android app
- Folder: nekko-agent, branch settings-tidy
- Done: grouped the rows, moved About to the end
- Open: the dark theme preview still uses the old colours

---

Now fix the dark theme preview too"""

    private val note = "I'll read SettingsScreen.kt and the theme preview first, then check how the colours are picked before changing anything."
    private val reply = "Done: the dark theme preview now uses the theme's own colours. I checked it in light and dark."

    private fun show() {
        compose.setContent {
            NekkoTheme(dark = false) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    BlockView(Block.User("u1", summary))
                    BlockView(Block.Assistant("a1", note), voice = Voice.WORKING)
                    BlockView(Block.Assistant("a2", reply), voice = Voice.REPLY)
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun summaryAndProgressNotesFoldAway() {
        show()
        shot("1-default")
        if (before) return
        // Folded: neither the summary nor the note shows; the merged prompt and the reply do.
        assertTrue(compose.onAllNodes(hasText("Folder: nekko-agent", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText(note), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("Now fix the dark theme preview too", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText(reply, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        // Open: the original text, unchanged.
        compose.onNodeWithTag("chat.contextSummary").performClick()
        compose.onNodeWithTag("chat.progressNote").performClick()
        compose.waitForIdle()
        assertTrue(compose.onAllNodes(hasText("Folder: nekko-agent", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText(note, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        shot("2-expanded")
    }

    private fun shot(name: String) {
        Thread.sleep(500)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "quiet-$name-${if (before) "before" else "after"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
