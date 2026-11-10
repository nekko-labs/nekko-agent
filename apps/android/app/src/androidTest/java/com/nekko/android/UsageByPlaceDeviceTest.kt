package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.material3.Surface
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.screens.UsagePlacesList
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.PhoneUsageLedger
import com.nekko.protocol.ProviderLimits
import com.nekko.protocol.PublicProvider
import com.nekko.protocol.UsagePlace
import com.nekko.protocol.UsageSummary
import java.io.File
import java.time.ZoneOffset
import org.junit.Rule
import org.junit.Test

/**
 * #2114: Usage and limits by place on the real list: All places, a computer online (subscription
 * with its limits, API with its spend, recent days folded), one offline with its last numbers, one
 * never read, and this phone's own chats, tokens only. Synthetic places, no relay.
 */
class UsageByPlaceDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')

    private val mac = UsagePlace.computer(
        "mac", "Studio Mac",
        UsageSummary(
            1_820_000, 240_000, 18.4,
            listOf(
                UsageSummary.Model("claude-opus-5-5", 1_200_000, 160_000, 0.0, true),
                UsageSummary.Model("gpt-5", 420_000, 60_000, 14.1, false),
                UsageSummary.Model("gemini-3-pro", 120_000, 15_000, 4.3, false),
            ),
            listOf(UsageSummary.Day("2026-11-09", 640_000, 6.1), UsageSummary.Day("2026-11-10", 910_000, 8.2)),
        ),
        listOf(PublicProvider("claude", "anthropic", "Claude", true), PublicProvider("openai", "openai", "OpenAI", true)),
        mapOf("claude" to ProviderLimits("max", listOf(ProviderLimits.Window("5h", "5 hours", 62.0, null, "allowed"), ProviderLimits.Window("7d", "Week", 85.0, null, "warning")), null)),
        readAt = null,
    )
    private val pc = UsagePlace("pc", UsagePlace.Kind.COMPUTER, "Office PC", online = false,
        summary = UsageSummary(300_000, 40_000, 2.2, listOf(UsageSummary.Model("gpt-5", 300_000, 40_000, 2.2, false)), emptyList()))
    private val laptop = UsagePlace("laptop", UsagePlace.Kind.COMPUTER, "Old laptop", online = false)
    private val phone = PhoneUsageLedger()
        .record("a", "Claude", "claude-haiku-5-5", 18_000, 4_200, 0, ZoneOffset.UTC)
        .record("o", "OpenRouter", "llama-4", 2_000, 900, 0, ZoneOffset.UTC)
        .place()

    @Test fun byComputerAndByThisPhone() {
        compose.setContent {
            NekkoTheme(dark = false) {
                Surface(color = Nekko.palette.paper) {
                    UsagePlacesList(listOf(mac, pc, laptop, phone), loaded = true, loading = false, iconOf = { if (it == "mac") "desktop" else "laptop" })
                }
            }
        }
        compose.onAllNodes(hasText("ALL PLACES")).onFirst().assertExists()
        compose.onAllNodes(hasText("2 offline: their last numbers are counted.")).onFirst().assertExists()
        compose.onAllNodes(hasText("Claude · Max")).onFirst().assertExists()
        compose.onAllNodes(hasText("SUBSCRIPTIONS")).onFirst().assertExists()
        shot("1-top")
        compose.onNodeWithTag("usage.days.mac").performClick()
        compose.onNodeWithTag("usage.view").performScrollToNode(hasText("OFFICE PC · OFFLINE"))
        compose.onAllNodes(hasText("Offline. These are the last numbers it gave.")).onFirst().assertExists()
        shot("2-offline")
        compose.onNodeWithTag("usage.view").performScrollToNode(hasText("This phone has no prices: tokens only."))
        compose.onAllNodes(hasText("THIS PHONE")).onFirst().assertExists()
        compose.onAllNodes(hasText("Offline. Its usage shows when it reconnects.")).onFirst().assertExists()
        shot("3-phone")
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(500)
        var bitmap: Bitmap? = null
        for (i in 0 until 10) { bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot(); if (bitmap != null) break; Thread.sleep(300) }
        val dir = File(compose.activity.getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "usage-$name-$device.png").outputStream().use { bitmap!!.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
