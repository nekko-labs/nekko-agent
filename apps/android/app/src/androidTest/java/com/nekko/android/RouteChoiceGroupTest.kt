package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.ui.settings.RouteChoiceGroup
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.RouteChoice
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The "Connect through" group on a computer's page (#3346): two checkboxes, the last one on stays on. */
@RunWith(AndroidJUnit4::class)
class RouteChoiceGroupTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val tailnet = "ws://studio.tail1234.ts.net:4400"
    private val cloud = "wss://nekko-agent-relay.fly.dev"

    private var choice by mutableStateOf(RouteChoice.AUTO)

    private fun show(routes: List<String>, start: RouteChoice = RouteChoice.AUTO) {
        choice = start
        compose.setContent {
            NekkoTheme(dark = false) {
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).padding(top = 48.dp)) {
                    RouteChoiceGroup("Studio", routes, choice) { choice = it }
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun bothOnIsAutoAndTheLastOneOnCannotBeTurnedOff() {
        show(listOf(tailnet, cloud))
        compose.onNodeWithTag("computer.route.tailscale").assertIsOn()
        compose.onNodeWithTag("computer.route.cloud").assertIsOn()
        shot("1-both")
        compose.onNodeWithTag("computer.route.tailscale").performClick()
        compose.waitForIdle()
        assertEquals(RouteChoice.CLOUD, choice)
        compose.onNodeWithTag("computer.route.tailscale").assertIsOff()
        shot("2-cloud-only")
        // Nekko Cloud Relay is the last one on: tapping it changes nothing.
        compose.onNodeWithTag("computer.route.cloud").performClick()
        compose.waitForIdle()
        assertEquals(RouteChoice.CLOUD, choice)
        compose.onNodeWithTag("computer.route.tailscale").performClick()
        compose.waitForIdle()
        assertEquals(RouteChoice.AUTO, choice)
    }

    @Test fun aKindTheLinkDidNotCarryIsOffWithOneQuietLine() {
        show(listOf(tailnet))
        compose.onNodeWithTag("computer.route.cloud").assertIsOff()
        compose.onNode(hasText("Pair again from Studio with Nekko Cloud Relay on to add it.")).assertIsDisplayed()
        compose.onNodeWithTag("computer.route.tailscale").performClick()
        compose.waitForIdle()
        assertEquals("Tailscale is the only one and stays on", RouteChoice.AUTO, choice)
        shot("3-no-cloud-carried")
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(500)
        var shot: Bitmap? = null
        for (i in 0 until 10) {
            shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            if (shot != null) break
            Thread.sleep(300)
        }
        val bitmap = shot ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "route-choice-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
