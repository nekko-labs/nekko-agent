package com.nekko.android

import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.nekko.android.ui.screens.ChatRow
import com.nekko.android.ui.theme.LightPalette
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Activity
import com.nekko.protocol.SessionSummary
import com.nekko.protocol.WireJson
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatStatusTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun row(archived: Boolean, watches: Int, activity: Activity? = null) {
        val summary = SessionSummary.from(WireJson.parseToJsonElement(
            """{"id":"status","title":"Status","activeWatchCount":$watches,"archivedAt":${if (archived) "1" else "null"}}""",
        ))!!
        compose.setContent { NekkoTheme(dark = false) { ChatRow(summary, activity, {}, {}) } }
    }

    @Test fun archivedWatchIsIdle() {
        row(archived = true, watches = 1)
        compose.onNodeWithContentDescription("Idle", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Done", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun archivedWithoutWatchUsesGrayDoneCheck() {
        row(archived = true, watches = 0)
        assertGrayDoneCheck()
    }

    @Test fun unarchivedWithoutWatchUsesGrayDoneCheck() {
        row(archived = false, watches = 0)
        assertGrayDoneCheck()
    }

    private fun assertGrayDoneCheck() {
        val bitmap = compose.onNodeWithContentDescription("Done", useUnmergedTree = true)
            .captureToImage().asAndroidBitmap()
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("Check contains the gray inkFaint tint", pixels.any { it == LightPalette.inkFaint.toArgb() })
        assertTrue("Check does not contain the green success tint", pixels.none { it == LightPalette.success.toArgb() })
    }

    @Test fun runningOverridesArchivedWatch() {
        row(archived = true, watches = 1, activity = Activity.RUNNING)
        compose.onNodeWithText("Working", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Working", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Idle", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun needsYouOverridesArchivedWatch() {
        row(archived = true, watches = 1, activity = Activity.NEEDS_YOU)
        compose.onNodeWithText("Needs you", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Needs you", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("Idle", useUnmergedTree = true).assertDoesNotExist()
    }
}
