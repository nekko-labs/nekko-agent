package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ComputerScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayConfig
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * #2059: the computer page's Models, folded with All / Cloud / Local, and "Connect to <name>":
 * off closes the link and keeps the pairing; on dials again. Screenshots in `evidence/computer-*.png`.
 */
class ComputerSettingsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val dials = mutableListOf<RelayConfig>()

    private fun answer(channel: String, args: Array<out JsonElement>): JsonElement = when (channel) {
        Channels.PROVIDERS_LIST -> WireJson.parseToJsonElement("""[{"id":"anthropic","kind":"anthropic","label":"Claude API","enabled":true},{"id":"ollama","kind":"ollama","label":"Ollama","enabled":true}]""")
        Channels.MODELS_LIST -> when ((args.firstOrNull() as? JsonPrimitive)?.content) {
            "anthropic" -> WireJson.parseToJsonElement("""[{"id":"claude-sonnet-5-5","name":"Claude Sonnet 5.5"},{"id":"claude-haiku-5-5","name":"Claude Haiku 5.5"}]""")
            "ollama" -> WireJson.parseToJsonElement("""[{"id":"qwen3:8b","name":"Qwen3 8B","loaded":true}]""")
            else -> WireJson.parseToJsonElement("[]")
        }
        Channels.MACHINE_SUMMARY -> WireJson.parseToJsonElement("""{"platform":"darwin","version":"0.9.4","edition":"desktop"}""")
        else -> JsonNull
    }

    private fun remote(config: RelayConfig): Remote = object : Remote {
        override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
        override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
        override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
        override fun connect() { dials += config; status.value = RelayStatus(RelayState.ONLINE) }
        override fun close() { status.value = RelayStatus(RelayState.IDLE) }
        override fun nudge() {}
        override fun reconnect() {}
        override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, args)
        override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, args)
    }

    private fun scrollTo(tag: String) {
        compose.onNode(hasTestTag("computer.scroll")).performScrollToNode(hasTestTag(tag))
        compose.waitForIdle()
    }

    @Test fun modelsFilterAndConnectionSwitch() {
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { config, _ -> remote(config) },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
        )
        val id = runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
            repo.loadAllModels(force = true)
            id
        }
        compose.setContent { NekkoTheme(dark = false) { ComputerScreen(repo, id, onBack = {}, onProviders = {}) } }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE && repo.state.value.models.size == 2 }

        // Models: folded, with a count; open, then Local only.
        scrollTo("computer.models")
        compose.onNode(hasText("Qwen3 8B", substring = true), useUnmergedTree = true).assertDoesNotExist()
        shot("1-models-folded")
        compose.onNodeWithTag("computer.models").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("modelPicker.scope.local").performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Qwen3 8B", substring = true), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Claude Sonnet 5.5", substring = true), useUnmergedTree = true).assertDoesNotExist()
        shot("2-models-local")

        // Connect to: off closes the link and keeps the pairing; nothing dials it again.
        scrollTo("computer.connect")
        compose.onNodeWithTag("computer.connect").performClick()
        compose.waitUntil(5_000) { repo.state.value.conn == RelayState.IDLE }
        val dialed = dials.size
        repo.nudge()
        Thread.sleep(500)
        assertEquals("not dialed while off", dialed, dials.size)
        assertFalse(repo.connectionEnabled(id))
        assertTrue("still paired", repo.state.value.computers.any { it.id == id })
        compose.waitForIdle()
        scrollTo("computer.connect")
        compose.onNodeWithTag("computer.connect").assertIsOff()
        shot("3-connect-off")

        // On again: dialed.
        compose.onNodeWithTag("computer.connect").performClick()
        compose.waitUntil(5_000) { repo.state.value.conn == RelayState.ONLINE }
        assertTrue(dials.size > dialed)
        compose.waitForIdle()
        compose.onNodeWithTag("computer.connect").assertIsOn()
        shot("4-connect-on")
    }

    private fun shot(name: String) {
        Thread.sleep(400)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "computer-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
