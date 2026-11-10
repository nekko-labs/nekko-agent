package com.nekko.android

import android.animation.ValueAnimator
import android.os.ParcelFileDescriptor
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.test.platform.app.InstrumentationRegistry
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nekko.android.data.Computer
import com.nekko.android.data.ComputersState
import com.nekko.android.ui.components.ConnectionBanner
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.DenyReason
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class QuietReconnectBannerTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val mac = Computer("mac", "Studio Mac", "wss://relay.example.com", 0)
    private val initial = ComputersState(ready = true, computers = listOf(mac), activeId = mac.id, conn = RelayState.CONNECTING)

    @Test fun dotStopsWhenSystemAnimationsAreDisabledWhileOpen() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).bufferedReader().use { it.readText().trim() }
        val original = shell("settings get global animator_duration_scale")
        try {
            shell("settings put global animator_duration_scale 1")
            compose.waitUntil(5_000) { ValueAnimator.areAnimatorsEnabled() }
            fun pixels(): List<androidx.compose.ui.graphics.Color> {
                val image = compose.onNodeWithTag("connection.dot", useUnmergedTree = true).captureToImage().toPixelMap()
                return (0 until image.height).flatMap { y -> (0 until image.width).map { x -> image[x, y] } }
            }
            compose.mainClock.autoAdvance = false
            compose.setContent { NekkoTheme(dark = false) { ConnectionBanner(initial, {}, {}) } }
            compose.mainClock.advanceTimeBy(200)
            val pulsing = pixels()
            compose.mainClock.advanceTimeBy(500)
            assertNotEquals("An enabled reconnect dot must change opacity", pulsing, pixels())
            compose.mainClock.autoAdvance = true
            // Let the live observer remove the infinite animation, not just freeze its clock.
            shell("settings put global animator_duration_scale 0")
            compose.waitUntil(5_000) { !ValueAnimator.areAnimatorsEnabled() }
            compose.waitForIdle()
            val before = pixels()
            Thread.sleep(1100)
            assertEquals(before, pixels())
        } finally {
            if (original == "null") shell("settings delete global animator_duration_scale")
            else shell("settings put global animator_duration_scale $original")
        }
    }

    @Test fun dynamicNameAndQueueCountShareOneQuietRow() {
        var state by mutableStateOf(initial)
        var count by mutableStateOf(0)
        var manages = 0
        compose.setContent { NekkoTheme(dark = false) { ConnectionBanner(state, {}, { manages++ }, queuedCount = count) } }
        compose.onNode(hasText("Reconnecting to Studio Mac...")).assertExists()
        compose.onNodeWithTag("chats.outboxNote").assertDoesNotExist()
        compose.runOnIdle { count = 1 }
        compose.onNode(hasText("1 prompt will send when reconnected.")).assertExists()
        compose.runOnIdle { count = 2; state = state.copy(computers = listOf(mac.copy(name = "Travel PC"))) }
        compose.onNode(hasText("Reconnecting to Travel PC...")).assertExists()
        compose.onNode(hasText("2 prompts will send when reconnected.")).assertExists()
        compose.onNode(hasText("Reconnecting to Travel PC...")).performClick()
        assertEquals(1, manages)
        compose.runOnIdle { state = state.copy(conn = RelayState.ONLINE) }
        compose.onNodeWithTag("chats.outboxNote").assertDoesNotExist()
    }

    @Test fun specialErrorsKeepTheirRepairActionsAndOfflineIsNotReconnecting() {
        var state by mutableStateOf(initial.copy(conn = RelayState.OFFLINE))
        var pairs = 0
        compose.setContent { NekkoTheme(dark = false) { ConnectionBanner(state, { pairs++ }, {}) } }
        compose.onNode(hasText("Studio Mac is offline. Open Nekko Agent on it.")).assertExists()
        compose.runOnIdle { state = state.copy(conn = RelayState.DENIED, denied = DenyReason.BAD_KEY) }
        compose.onNode(hasText(compose.activity.getString(R.string.chats_denied_bad_key))).assertExists().performClick()
        assertEquals(1, pairs)
        compose.runOnIdle { state = initial.copy(connDetail = RelayStatus.HOST_NOT_FOUND) }
        compose.onNode(hasText("Reconnecting to Studio Mac...")).assertDoesNotExist()
    }
}
