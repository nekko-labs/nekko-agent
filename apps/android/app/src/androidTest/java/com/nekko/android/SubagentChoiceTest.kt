package com.nekko.android

import android.graphics.Bitmap
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.SkillSummary
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The composer's follow-up choice: shown for typed work, gone for a slash
 * command, and each action sends the right text (the same words as
 * `inSubagent` in orchestration.ts). Screenshots go to `evidence/`.
 */
@RunWith(AndroidJUnit4::class)
class SubagentChoiceTest {
    @get:Rule val compose = createComposeRule()

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "dark"
    private val sent = mutableListOf<String>()
    private val box get() = compose.onNode(hasContentDescription("Message"))

    private fun composer(offer: Boolean = true) {
        compose.setContent {
            NekkoTheme(dark = theme == "dark") {
                Composer(
                    running = false,
                    blocked = null,
                    queued = emptyList(),
                    onSend = { text, _, _ -> sent += text },
                    onStop = {},
                    skills = listOf(SkillSummary(name = "review", description = "Review a change", category = "code", source = "builtin")),
                    offerSubagent = offer,
                    modifier = Modifier.width(360.dp),
                )
            }
        }
    }

    @Test
    fun aTypedFollowUpGoesHereOrToASubagent() {
        composer()
        compose.onNodeWithTag("composer.inSubagent").assertDoesNotExist()
        box.performTextInput("/review")
        compose.onNodeWithTag("composer.inSubagent").assertDoesNotExist()
        box.performTextReplacement("Fix the tests")
        compose.onNodeWithText("uses more context").assertExists()
        shot("subagent-typed")

        compose.onNodeWithTag("composer.inSubagent").performClick()
        compose.waitUntil { sent.size == 1 }
        assertEquals("Do this in a subagent, then report back:\n\nFix the tests", sent[0])
        compose.onNodeWithTag("composer.inSubagent").assertDoesNotExist()

        box.performTextInput("Add a test")
        compose.onNodeWithTag("composer.doItHere").performClick()
        compose.waitUntil { sent.size == 2 }
        assertEquals("Add a test", sent[1])
    }

    @Test
    fun hiddenWhereDelegationCannotRun() {
        composer(offer = false)
        box.performTextInput("Fix the tests")
        compose.onNodeWithTag("composer.inSubagent").assertDoesNotExist()
        compose.onNodeWithTag("composer.doItHere").assertDoesNotExist()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
