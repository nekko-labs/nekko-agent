package com.nekko.android

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.nekko.android.data.ComputersRepository
import com.nekko.android.data.Remote
import com.nekko.android.data.SecureStore
import com.nekko.android.ui.screens.ComputerScreen
import com.nekko.android.ui.theme.NekkoTheme
import com.nekko.protocol.Channels
import com.nekko.protocol.RelayException
import com.nekko.protocol.RelayState
import com.nekko.protocol.RelayStatus
import com.nekko.protocol.ServiceChannels
import com.nekko.protocol.SoftwareChangeSigner
import com.nekko.protocol.StepUpProof
import com.nekko.protocol.WelcomedDevice
import com.nekko.protocol.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Decision 0064: the computer page's *CI runners*, read through the connected computer. Absent
 * while no computer reports a runner (or the computer refuses the channel). Screenshots in
 * `evidence/fleet-runners-*.png`.
 */
class FleetRunnersDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val fleet = WireJson.parseToJsonElement(
        """{"orgs":[{"orgName":"Nekko Labs","computers":[
          {"deviceId":"d1","name":"Studio Mac","os":"macos","online":true,"you":true,"runners":[
            {"label":"nekko-cloud-mac","state":"running","busy":1,"slots":2},
            {"label":"nekko-cloud-mac-mini","state":"error","busy":0,"slots":0}]},
          {"deviceId":"d2","name":"Office mini","os":"macos","online":true,"runners":[{"label":"office","state":"ready","busy":0,"slots":2}]},
          {"deviceId":"d3","name":"Travel laptop","os":"macos","online":false,"runners":[{"label":"laptop","state":"ready","busy":0,"slots":1}]}]}]}""",
    )

    private fun answer(channel: String, runners: Boolean): JsonElement = when (channel) {
        Channels.FLEET_RUNNERS -> if (runners) fleet else throw RelayException("unknown channel fleet:runners")
        ServiceChannels.STATUS -> WireJson.parseToJsonElement(
            """{"protocolVersion":1,"agentRunning":true,"manageServiceFromPhone":false,"capabilities":{
            "restart":{"supported":true},"updateState":{"supported":true},"updateCheck":{"supported":true},
            "updateDownload":{"supported":true},"updateInstall":{"supported":true}}}""",
        )
        Channels.MACHINE_SUMMARY -> WireJson.parseToJsonElement("""{"platform":"darwin","version":"0.9.4","edition":"desktop"}""")
        else -> JsonNull
    }

    private fun show(dark: Boolean, runners: Boolean) {
        val repo = ComputersRepository(
            store = object : SecureStore {
                private val map = HashMap<String, String>()
                override suspend fun get(key: String) = map[key]
                override suspend fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
            },
            remotes = { _, _ ->
                object : Remote {
                    override val status = MutableStateFlow(RelayStatus(RelayState.IDLE))
                    override val events = MutableSharedFlow<Pair<String, JsonElement>>(extraBufferCapacity = 64)
                    override val welcome = MutableSharedFlow<WelcomedDevice>(replay = 1, extraBufferCapacity = 1)
                    override fun connect() { status.value = RelayStatus(RelayState.ONLINE) }
                    override fun close() { status.value = RelayStatus(RelayState.IDLE) }
                    override fun nudge() {}
                    override fun reconnect() {}
                    override suspend fun call(channel: String, vararg args: JsonElement) = answer(channel, runners)
                    override suspend fun callWithTimeout(timeoutMs: Long, channel: String, vararg args: JsonElement) = answer(channel, runners)
                    override suspend fun callSigned(channel: String, args: JsonArray, proof: JsonObject, stepUp: StepUpProof?, timeoutMs: Long?): JsonElement = JsonNull
                }
            },
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
            deviceName = { "Pixel" },
            deriveKey = { _, _ -> ByteArray(32) },
            changeSigner = SoftwareChangeSigner.generate(),
        )
        val id = runBlocking {
            val id = repo.pair(testPairing())
            repo.rename(id, "Studio Mac")
            repo.load()
            id
        }
        compose.setContent { NekkoTheme(dark = dark) { ComputerScreen(repo, id, onBack = {}, onProviders = {}) } }
        compose.waitUntil(10_000) { repo.state.value.conn == RelayState.ONLINE }
        compose.waitUntil(8_000) { compose.onAllNodes(hasTestTag("service.section"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun scrollTo(tag: String) {
        compose.onNode(hasTestTag("computer.scroll")).performScrollToNode(hasTestTag(tag))
        compose.waitForIdle()
    }

    @Test fun absentWithoutRunners() {
        show(dark = false, runners = false)
        scrollTo("service.section")
        compose.onNodeWithTag("fleetRunners.section").assertDoesNotExist()
        shot("none-light")
    }

    @Test fun listsTheFleetLight() = lists(dark = false)

    @Test fun listsTheFleetDark() = lists(dark = true)

    private fun lists(dark: Boolean) {
        show(dark, runners = true)
        compose.waitUntil(8_000) { compose.onAllNodes(hasTestTag("fleetRunners.section")).fetchSemanticsNodes().isNotEmpty() }
        scrollTo("fleetRunners.section")
        compose.onNode(hasText("CI runner nekko-cloud-mac: running a job (1 of 2 VMs)"), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Offline"), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("CI runner laptop", substring = true), useUnmergedTree = true).assertDoesNotExist()
        shot(if (dark) "dark" else "light")
    }

    private fun shot(name: String) {
        Thread.sleep(400)
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("No screenshot for $name")
        val dir = File(ApplicationProvider.getApplicationContext<NekkoApp>().getExternalFilesDir(null), "evidence").apply { mkdirs() }
        File(dir, "fleet-runners-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
