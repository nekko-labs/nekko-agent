package com.nekko.android

import android.graphics.Bitmap
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.chat.Composer
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.SkillSummary
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A `/` typed after existing text opens the skill menu, and picking a skill
 * keeps the text before the `/`. Screenshots go to the app's external files
 * (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class SkillMenuAfterTextTest {
    @get:Rule val compose = createComposeRule()

    private val theme = InstrumentationRegistry.getArguments().getString("nekkoTheme") ?: "dark"

    @Test
    fun slashAfterTextOpensTheMenuAndKeepsTheText() {
        val skills = listOf(
            SkillSummary(name = "plan", description = "Break the work into steps", category = "planning", source = "builtin"),
            SkillSummary(name = "review", description = "Review the code for bugs", category = "code", source = "claude"),
        )
        compose.setContent {
            NekkoTheme(dark = theme == "dark") {
                Composer(
                    running = false,
                    blocked = null,
                    queued = emptyList(),
                    onSend = { _, _, _ -> },
                    onStop = {},
                    skills = skills,
                    modifier = Modifier.width(360.dp),
                )
            }
        }
        val box = compose.onNode(hasContentDescription("Message"))
        box.performTextInput("Help me with this /")
        shot("slash-after-text")
        compose.onNodeWithContentDescription("Skills on your computer").assertIsDisplayed()

        box.performTextInput("pl")
        compose.onNodeWithText("/plan").performClick()
        shot("slash-after-text-picked")
        compose.onNodeWithContentDescription("Remove skill /plan").assertIsDisplayed()
        box.assert(hasText("Help me with this ", substring = false))
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "$theme-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
