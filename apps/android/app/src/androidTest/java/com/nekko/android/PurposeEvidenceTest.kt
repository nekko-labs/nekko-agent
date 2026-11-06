package com.nekko.android

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test

/** Exercises the real cards with the offline debug activity, without a relay. */
class PurposeEvidenceTest {
    @get:Rule
    val compose = createAndroidComposeRule<PurposeEvidenceActivity>()

    @Test
    fun groupsRevealAndHideCallsAndKeepFailuresVisible() {
        val guidance = compose.onNodeWithContentDescription("Read the project's guidance, AGENTS.md, CLAUDE.md, 2 calls")
        compose.onNodeWithText("AGENTS.md", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("npm run lint", useUnmergedTree = true).assertExists()
        guidance.performClick()
        compose.onNodeWithText("AGENTS.md", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("CLAUDE.md", useUnmergedTree = true).assertExists()
        guidance.performClick()
        compose.onNodeWithText("AGENTS.md", useUnmergedTree = true).assertDoesNotExist()
        val exploration = compose.onNodeWithContentDescription("Looked through the code, 2 files, 2 calls")
        exploration.performClick()
        compose.onNodeWithText("src/chat.ts", useUnmergedTree = true).assertExists()
        exploration.performClick()
        compose.onNodeWithText("src/chat.ts", useUnmergedTree = true).assertDoesNotExist()
    }
}
