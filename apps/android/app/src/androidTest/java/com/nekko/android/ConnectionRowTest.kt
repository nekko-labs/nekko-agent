package com.nekko.android

import android.graphics.Bitmap
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.connection.ConnectionFacts
import com.nekko.android.connection.ConnectionNote
import com.nekko.android.connection.ConnectionNotes
import com.nekko.android.ui.components.ConnectionRow
import com.nekko.android.ui.theme.Nekko
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.DenyReason
import com.nekko.protocol.RelayRoute
import com.nekko.protocol.RelayState
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The connection row on the device: every computer as a dot and a name, one word for a problem,
 * one line and its fixes behind a tap (spec/phone/iphone-connection-strip.md). The states are the
 * iPhone's `-uiTestConnectionStrip` fixture's; each step is a whole-screen screenshot under the
 * app's external files (`evidence/`).
 */
@RunWith(AndroidJUnit4::class)
class ConnectionRowTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val device = InstrumentationRegistry.getArguments().getString("nekkoDevice") ?: Build.MODEL.replace(' ', '_')
    private val acted = mutableListOf<Pair<String, ConnectionNote.Action>>()

    private fun facts(
        id: String, state: RelayState = RelayState.ONLINE, route: RelayRoute = RelayRoute.INTERNET, active: Boolean = false,
        detail: String? = null, denied: DenyReason? = null,
    ) = ConnectionFacts(id, id.replaceFirstChar { it.uppercase() }, route, "relay.example.dev", state, detail, denied, active)

    private fun show(notes: List<ConnectionNote>, open: String? = null, dark: Boolean = false) {
        compose.setContent {
            NekkoTheme(dark = dark) {
                Column(Modifier.fillMaxSize().background(Nekko.palette.paper).padding(top = 48.dp)) {
                    Text("Chats", style = MaterialTheme.typography.headlineSmall, color = Nekko.palette.ink, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                    ConnectionRow(notes, null, initiallyOpen = open, onAction = { n, a -> acted += n.id to a })
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun threeComputersOnlineAreDotsAndNamesOnly() {
        show(ConnectionNotes.make(listOf(facts("studio", active = true), facts("gomi"), facts("laptop")), tailscaleOn = true))
        listOf("studio", "gomi", "laptop").forEach { compose.onNodeWithTag("strip.$it").assertIsDisplayed() }
        compose.onNodeWithTag("strip.line").assertDoesNotExist()
        compose.onAllNodes(hasContentDescription("offline", substring = true)).assertCountEquals(0)
        shot("1-all-online")
    }

    @Test fun tailscaleOffLeadsAndOpensToOpenTailscale() {
        val notes = ConnectionNotes.make(listOf(facts("studio", RelayState.CONNECTING, RelayRoute.TAILSCALE, active = true), facts("gomi"), facts("laptop")), tailscaleOn = false)
        assertEquals("tailscale", notes.first().id)
        show(notes)
        compose.onNodeWithTag("strip.tailscale").performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Turn on Tailscale to reach Studio.", substring = true)).assertIsDisplayed()
        compose.onNodeWithTag("open-tailscale").assertIsDisplayed()
        compose.onNodeWithTag("banner.details").assertIsDisplayed()
        shot("2-tailscale-off-open")
        compose.onNodeWithTag("open-tailscale").performClick()
        assertEquals(listOf("tailscale" to ConnectionNote.Action.OPEN_TAILSCALE), acted)
        // Tap the item again to close it.
        compose.onNodeWithTag("strip.tailscale").performClick()
        compose.waitUntil(3_000) { compose.onAllNodes(hasText("Turn on Tailscale", substring = true)).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun silentComputerSaysNoAnswerAndRetries() {
        val notes = ConnectionNotes.make(
            listOf(facts("studio", RelayState.CONNECTING, RelayRoute.TAILSCALE, active = true, detail = "timeout"), facts("gomi"), facts("laptop", RelayState.OFFLINE)),
            tailscaleOn = true,
        )
        show(notes, open = "studio")
        compose.onNode(hasContentDescription("Studio, no answer")).assertIsDisplayed()
        compose.onNode(hasText("Studio doesn’t answer on your tailnet.", substring = true)).assertIsDisplayed()
        shot("3-no-answer-open")
        compose.onNodeWithTag("fleet.reconnect").performClick()
        assertEquals(listOf("studio" to ConnectionNote.Action.RETRY), acted)
    }

    @Test fun removedComputerIsRefusedAndOpensToPairAgain() {
        val notes = ConnectionNotes.make(listOf(facts("studio", active = true), facts("gomi", RelayState.DENIED, denied = DenyReason.REVOKED)), tailscaleOn = true)
        show(notes, open = "gomi")
        compose.onNode(hasContentDescription("Gomi, refused")).assertIsDisplayed()
        compose.onNodeWithTag("banner.pair-again").assertIsDisplayed()
        compose.onAllNodes(hasText("Retry")).assertCountEquals(0)
        shot("4-refused-open")
        compose.onNodeWithTag("banner.pair-again").performClick()
        assertEquals(listOf("gomi" to ConnectionNote.Action.PAIR_AGAIN), acted)
    }

    @Test fun darkTheme() {
        val notes = ConnectionNotes.make(listOf(facts("studio", RelayState.CONNECTING, RelayRoute.TAILSCALE, active = true), facts("gomi"), facts("laptop", RelayState.OFFLINE)), tailscaleOn = false)
        show(notes, open = "tailscale", dark = true)
        shot("5-tailscale-off-dark")
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
        File(dir, "connection-row-$name-$device.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
